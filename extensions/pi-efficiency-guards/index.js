/**
 * pi-efficiency-guards —— 两个纯机械的效率护栏，钩子实现，零提示词成本。
 *
 * 1) 扫描护栏：拒绝无界递归的 shell 扫描（`Get-ChildItem -Recurse` / `find` 且没有深度限制）。
 *    依据：dsh 实测一次 `Get-ChildItem -Path X -Recurse` 阻塞 120 秒，
 *    `-Recurse | Where-Object` 这种“先全量遍历再过滤”的写法也照样 87 秒。
 * 2) 回合步数提示：同一回合到第 N 步时插入一句“用已有证据回答”，压住反复翻证据的长尾。
 *    依据：dsh 侧实测长尾回合里步数最多到 20+，提示能截断过度复核。
 *
 * 两个护栏都是钩子（`tool_call` / `turn_end`），不注册工具、不加系统提示段落，
 * 因此不增加任何常驻 token。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const AGENT_DIR = process.env.PI_AGENT_DIR ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.pi', 'agent')

/** pwsh / cmd 的递归开关；命中后再看是否给了深度上限。 */
const POWERSHELL_RECURSION = /\b(?:get-childitem|gci|dir|ls)\b[^|;]*\s(?:-recurse|-r)\b/iu
const POWERSHELL_DEPTH = /\s-depth\b/iu
/** POSIX find 的递归是隐含的，只有 -maxdepth/-depth 才算有界。 */
const FIND_RECURSION = /(?:^|[;&|]|\n)\s*\bfind\s/iu
const FIND_DEPTH = /\s-(?:maxdepth|depth)\b/iu
/** cmd 的递归开关：`dir /s`。 */
const CMD_RECURSION = /(?:^|[;&|]|\n)\s*\bdir\s+\/s\b/iu

const DEFAULT_THRESHOLDS = [12, 24]

/** 页脚状态位：本回合已跑几步、是否发过提示。 */
const STATUS_KEY = 'efficiency-guards'

/** 读取 JSON；缺失或损坏返回 undefined。 */
function readJson (file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 合并全局与项目配置。 */
function readConfig (cwd) {
  const global = readJson(join(AGENT_DIR, 'efficiency-guards.json')) ?? {}
  const project = readJson(join(cwd, '.pi', 'efficiency-guards.json')) ?? {}
  const scan = { ...(global.scan ?? {}), ...(project.scan ?? {}) }
  const budget = { ...(global.turnBudget ?? {}), ...(project.turnBudget ?? {}) }
  const thresholds = Array.isArray(budget.thresholds) ? budget.thresholds.map(Number).filter((value) => Number.isInteger(value) && value > 1) : DEFAULT_THRESHOLDS
  return {
    scanEnabled: scan.enabled !== false,
    scanTools: Array.isArray(scan.tools) ? scan.tools.map(String) : ['bash', 'pwsh'],
    budgetEnabled: budget.enabled !== false,
    thresholds: thresholds.length === 0 ? DEFAULT_THRESHOLDS : thresholds.slice().sort((left, right) => left - right),
  }
}

/** 把命令压成一行，供拒绝信息引用。 */
function quoted (command) {
  const flat = command.replace(/\s+/gu, ' ').trim()
  return flat.length <= 120 ? flat : `${flat.slice(0, 117)}…`
}

/**
 * 去掉引号内的字面量与 heredoc 正文，只留真正会被 shell 执行的部分。
 *
 * 没有这一步，写文件时把 `Get-ChildItem -Recurse` 当成文本放进 heredoc 也会被拒（实测踩到）。
 * 代价：`bash -c '…'` 这种把命令放进引号里的写法不再被拦；引号内的递归扫描非常少见，
 * 而把命令当文本粘贴进文件是常态。
 */
function commandSurface (command) {
  const heredoc = /<<[-~]?\s*('[^']*'|"[^"]*"|\S+)/u
  const kept = []
  let terminator
  for (const line of command.split(/\r?\n/u)) {
    if (terminator !== undefined) {
      if (line.trim() === terminator) terminator = undefined
      continue
    }
    const opened = heredoc.exec(line)
    if (opened !== null) terminator = opened[1].replace(/['"]/gu, '')
    kept.push(line)
  }
  const surface = kept.join('\n')
  let out = ''
  let index = 0
  while (index < surface.length) {
    const character = surface[index]
    if (character === "'" || character === '"' || character === '`') {
      index += 1
      while (index < surface.length) {
        const inner = surface[index]
        if (character === '"' && inner === '\\') {
          index += 2
          continue
        }
        if (inner === character) break
        index += 1
      }
      index += 1
      out += character + character
      continue
    }
    out += character
    index += 1
  }
  return out
}

/**
 * 找出“把命令当字符串交给另一个 shell”的写法，取回其中的命令文本。
 *
 * `powershell -Command "Get-ChildItem -Recurse"` 与 `bash -c 'find . -type f'` 里的内容
 * 会被执行，不能像普通字面量那样剥掉；否则包一层引号就绕过了护栏（实测绕过过）。
 */
function nestedCommands (command) {
  const invocations = /\b(?:powershell(?:\.exe)?|pwsh|bash|sh|cmd(?:\.exe)?|zsh|fish)\b[^"'`|;]*?(?:-c|-lc|\/c|-Command)\s*(["'`])([\s\S]*?)\1/giu
  const found = []
  for (const match of command.matchAll(invocations)) {
    if (typeof match[2] === 'string') found.push(match[2])
  }
  return found
}

/** 取 shell 工具的命令文本；其他工具返回 undefined。 */
function commandOf (input) {
  if (input === null || typeof input !== 'object') return undefined
  const command = Reflect.get(input, 'command')
  return typeof command === 'string' ? command : undefined
}

/** 提示文案：第 step 步。 */
function gentle (step) {
  return `This turn has run ${step} steps. Answer from the evidence you already gathered, or name what is still missing and why it blocks the answer; another pass over the same source will not change the result.`
}

/** 提示文案：更晚的阈值。 */
function firm (step) {
  return `This turn has run ${step} steps without delivering an answer. Deliver the answer the evidence supports now, and name the remaining unknown in the same reply.`
}

export default function efficiencyGuards (pi) {
  /** 自上次人类输入以来的回合数。 */
  let stepsSinceInput = 0
  /** 本回合已经发过的阈值，避免重复。 */
  const sent = new Set()

  pi.on('input', async (_event, ctx) => {
    stepsSinceInput = 0
    sent.clear()
    ctx.ui?.setStatus(STATUS_KEY, undefined)
    return undefined
  })

  pi.on('turn_end', async (event, ctx) => {
    // 只在还有工具结果、也就是工作要接着做的回合计数；纯文本回合本身就是答案，
    // 在它后面插一条用户消息会让 `-p` 模式打印不到最终答案，还会多付一次往返。
    if (event.toolResults.length === 0) {
      // 纯文本回合就是答案：清掉步数，下一轮从零开始。
      ctx.ui?.setStatus(STATUS_KEY, undefined)
      return undefined
    }
    stepsSinceInput += 1
    const config = readConfig(ctx.cwd)
    if (!config.budgetEnabled) {
      ctx.ui?.setStatus(STATUS_KEY, undefined)
      return undefined
    }
    const nudged = config.thresholds.includes(stepsSinceInput) && !sent.has(stepsSinceInput)
    // 状态位不花 token：步数始终可见，发过提示就标出来。
    ctx.ui?.setStatus(STATUS_KEY, `step ${stepsSinceInput}${nudged ? ' · nudged' : ''}`)
    if (!nudged) return undefined
    sent.add(stepsSinceInput)
    const text = stepsSinceInput > config.thresholds[0] ? firm(stepsSinceInput) : gentle(stepsSinceInput)
    return {
      entries: [
        ...event.entries,
        { type: 'custom_message', customType: 'turn-budget', content: text, display: false },
      ],
    }
  })

  pi.on('tool_call', async (event, ctx) => {
    const config = readConfig(ctx.cwd)
    if (!config.scanEnabled) return undefined
    if (!config.scanTools.includes(event.toolName)) return undefined
    const command = commandOf(event.input)
    if (command === undefined) return undefined
    const surface = `${commandSurface(command)}\n${nestedCommands(command).join('\n')}`
    const unbounded = (POWERSHELL_RECURSION.test(surface) && !POWERSHELL_DEPTH.test(surface)) ||
      (FIND_RECURSION.test(surface) && !FIND_DEPTH.test(surface)) ||
      CMD_RECURSION.test(surface)
    if (!unbounded) return undefined
    ctx.ui?.notify('refused an unbounded recursive scan — use glob/grep, or bound it with a depth limit', 'warning')
    const alternatives = 'glob lists paths and grep searches file contents in one pass.'
    return {
      block: true,
      reason: `refused a recursive scan: \`${quoted(command)}\` walks every subdirectory, including dependency trees such as node_modules, and can block for minutes. ${alternatives} A shell scan stays allowed when it names one directory and bounds its depth (\`-Depth N\` in pwsh, \`-maxdepth N\` in find).`,
    }
  })
}
