# pi-efficiency-guards

两个纯机械的效率护栏，钩子实现，**零提示词成本**：不注册工具、不加系统提示段落，只在触发的瞬间起作用。

## 护栏一：拒绝无界递归扫描

`tool_call` 钩子在 shell 工具执行前检查命令：

- `Get-ChildItem|gci|dir|ls … -Recurse`（无 `-Depth`）→ 拒绝
- `find …`（无 `-maxdepth`/`-depth`）→ 拒绝
- 只看真正会被执行的部分：引号内的字面量与 heredoc 正文先被剥掉，所以把递归命令当文本写进文件、或 `printf "… -Recurse"` 不会被误拒

拒绝信息给出替代方案（`glob` 列路径、`grep` 搜内容），并说明有界写法仍然允许。依据：dsh 侧实测一次 `Get-ChildItem -Path X -Recurse` 阻塞 120 秒；`-Recurse | Where-Object` 这种“先全量遍历再过滤”的写法也照样 87 秒，提示词拦不住，必须机械拒绝。

实测（本机，`C:/Code/AI/deepseek-harness`）：

```
guards=off: 23s   → Ran once — exit 0, returned 5 paths.
guards=on : 18s   → The single bash call was refused: …
```

误拒绝已修：把 `Get-ChildItem -Path packages -Recurse` 写进 `cat > f <<'EOF'` 的正文时曾整条命令被拒；现在先剥掉 heredoc 正文与引号内容再判断。八种输入的对照（`C:/tmp/verify-scan-surface.mjs`）：

```
refused  plain recursion             allowed  bounded recursion
refused  find                        allowed  find bounded
allowed  heredoc mentions it         allowed  double-quoted mention
allowed  single-quoted mention       refused  heredoc then real command
refused  powershell -Command wrapper  refused  bash -c wrapper
refused  cmd /c wrapper
```

真实 pi 进程验证：`node C:/tmp/verify-heredoc-live.mjs` 让子进程写一个含该命令文本的文件，退出码 0、文件三行内容正确。

## 护栏二：回合步数提示

`turn_end` 钩子统计同一回合里“有工具结果”的步数，到阈值时插入一条 `custom_message`（`customType: turn-budget`）：第 1 个阈值用温和版，之后的阈值用强硬版。插入发生在工具步之间，因此 下一次请求就能看到它；纯文本回合不计数也不插入（在答案后面插消息会让 `-p` 模式打印不到最终答案，还多付一次往返）。

默认阈值 `[12, 24]`。依据：长尾回合里步数最多到 20+，提示能截断“同一来源反复翻”的循环。

## 配置

全局 `<agent-dir>/efficiency-guards.json`，项目 `<cwd>/.pi/efficiency-guards.json` 覆盖同名键：

```json
{
  "scan": { "enabled": true, "tools": ["bash", "pwsh"] },
  "turnBudget": { "enabled": true, "thresholds": [12, 24] }
}
```

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `scan.enabled` | `true` | 是否拦截无界递归扫描 |
| `scan.tools` | `["bash","pwsh"]` | 需要检查的工具名 |
| `turnBudget.enabled` | `true` | 是否注入步数提示 |
| `turnBudget.thresholds` | `[12, 24]` | 触发步数，升序；第 1 个用温和文案 |

## 界面反馈

两个护栏都只用 `ctx.ui`，不写会话、不花 token：

- 页脚状态位 `efficiency-guards`：每次有工具结果的回合更新为 `step N`；该回合触发提示时追加 `· nudged`；纯文本回合（也就是答案）与新的用户输入都会清空它。
- 扫描被拒时 `ctx.ui.notify(..., 'warning')` 弹一条警告，文案与拒绝原因一致。

`-p`（打印）模式下这些调用不会抛错，只是不显示。

## 安装

```json
"packages": ["<克隆目录>/pi-efficiency-guards"]
```

## 验证方法

```sh
# 护栏一：应被拒绝
pi -p "Run bash exactly once with: find . -type f | head -5. Report whether it ran or was refused."
# 护栏二：临时把阈值调成 [2,3]，跑一个三步任务，再查会话里的 customType=turn-budget
# 页脚：交互模式下应看到 `step 2 · nudged` 这类状态位；拒扫描时会有 warning 通知
```

## 已知限制

- 护栏一只看命令文本，不理解语义：写 `for d in */; do …; done` 或 `rg` 全库搜索不会被拦（那不是递归遍历每一个子目录的代价点）。
- 引号内的字面量不算命令，但“把命令交给另一个 shell”的写法（`bash -c`、`sh -lc`、`pwsh -Command`、`cmd /c`）会先被取回再判，所以 `powershell -Command "Get-ChildItem -Recurse"` 仍然被拒。
- 珪不到的：多层封装（`bash -c "bash -c '…'"`）、把命令拼进变量再执行（`c=$x; eval $c`）。
- 护栏一放行 `-Depth N` / `-maxdepth N`，即使 N 很大。
- 护栏二的步数按“有工具结果的回合”计数，一次回合里并发多个工具调用仍算 1 步。
- 两个护栏都不改模型行为，只改变它看到的证据与提示；“同一路径反复取反证”如果发生在单个长回合内，提示不一定能立即截断。

## 从 GitHub 安装

```bash
git clone https://github.com/MinarKotonoha/pi-efficiency-guards.git <克隆目录>/pi-efficiency-guards
```

克隆后把这个目录加进 `~/.pi/agent/settings.json` 的 `packages` 里（即上文的路径写法），重启 pi 生效。插件走 `pi.extensions` 声明，不需要编译。

