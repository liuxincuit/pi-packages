# costtime

每轮对话的耗时：运行时显示在输入框里的 working 行，结束后落到对话流里。

## 做什么

| 阶段 | 表现 |
|---|---|
| agent 运行中 | 输入框里的 working 行显示 `Working 1m 12s`（spinner 照常转），每秒刷新 |
| 一轮结束 | 在该轮最后一条回复下方追加一条 `Worked 1h 15m 3s`（灰色） |

计时口径是**整个用户轮次**：`agent_start` → `agent_before_settle`，含工具执行、重试、自动继续。中途的 `agent_end` 不停表，因为之后可能还有重试或继续。

耗时按 `NhNmNs` 显示（`formatDuration`，index.ts 里的具名导出），值为 0 的单位省略：`45s`、`1m 5s`、`1h 2m 3s`、`1h`。超过 24 小时不进位到天，直接 `26h 3m`。

结束后写入的是 **custom entry**（`pi.appendEntry` 同类的会话条目），不参与 LLM 上下文——模型看不到这行耗时。`/resume`、`/tree` 回放时历史轮次的耗时照常显示。

**为什么用 working 行而不是输入框上方的 widget**：working 行本来就占位（流式期间显示），不额外占行；它在 dock 里排在所有 widget 之前（`pendingMessages → status → widgetsAbove → editor`），天然位于 `rpiv-todos`、`agents` 之上，因此不必靠扩展加载顺序去抢位置。`setWorkingMessage` 内部走 `Loader.setMessage`，自带 `requestRender`，每秒重写即可跳动——pi 自己的重试倒计时也是这个模式。

## 配置

无。结束后的条目颜色是 `index.ts` 顶部的一个主题语义色常量：`COLOR = "muted"`（dark `#808080` / light `#6c6c6c`）。运行中那行的颜色由 pi 决定（working 行的消息固定用 muted）。想换色改这一个常量（如 `"dim"` 更暗、`"accent"` 更醒目）。

## 调试

1. 跑一轮带工具的对话：输入框里的 working 行应从 `Working 0s` 逐秒跳到结束，spinner 继续转。
2. 结束后看对话流：最后一条回复下方应出现同数值的 `Worked Ns`（灰色，过去式，跟运行中的 `Working` 区分开）。
3. 验证工具执行期间仍可见：让模型跑一条耗时命令（如 `sleep 20`），期间 working 行应继续跳。
4. 验证中断：`Ctrl+C` 打断一轮，working 行应恢复默认文本（`Working`），且该轮仍写入耗时条目。
5. 验证父子隔离：起一个子代理跑几分钟，父会话的计时不应被子代理的耗时顶掉。

纯逻辑回归（不进 TUI）：

```bash
PI_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent"
node .pi/T/ext-verify/build.cjs .pi/T/ext-verify/costtime-behavior.mjs .pi/T/ext-verify/out-costtime.mjs
node .pi/T/ext-verify/out-costtime.mjs
```

覆盖：起表即显示、逐秒跳动、重试不重置起点、settle 恢复默认文本并写入 entry draft、停表后不再刷新。

## 陷阱

**只改 working 行的文本，不碰其它扩展**：`setWorkingMessage` 改的就是那个 working 行，而 `pi-subagents`、`rpiv-todo` 都用 widget、不用它，所以没有争用。若将来有扩展也用，两者会互相覆盖文本。

**`agent_start` 会被重试再次触发**，所以有「已在计时就不重置起点」的守卫；没有它，重试会把前半段耗时丢掉。

**`session_shutdown` 里只清定时器、不碰 UI**：会话被替换时 ctx 可能已经失效，调用 `setWorkingMessage` 会抛错。

**每轮写一条 entry**，会进 session jsonl，`/tree` 视图里能看到这些节点；`/compact` 之后被截断的旧轮次不再渲染耗时。

**计时精度是秒**，`Math.floor(ms / 1000)`。不足 1 秒的轮次显示 `0s`。秒是 tick 粒度，所以运行中的那行只会在整秒上跳（`1m 5s` → `1m 6s`）。

**working 行只在一轮运行期间存在**：agent 结束后 pi 会清掉它，结束后要看耗时只能看对话流里那一条。
