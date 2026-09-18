# next-phase

让模型在阶段完成后，把下一步交接给一个**干净的上下文**：用户按一下确认，当前会话自动切到同一棵 session tree 的新分支，在那里执行下一阶段。

## 做什么

链路（四块）：

1. **工具 `next_phase({ title, prompt })`** — 模型判断当前阶段做完时调用。弹出确认框（只显示 `title`，不预览 prompt 全文），用户确认后把 `{ title, prompt }` 记成交接 entry，返回 `terminate: true` 结束本轮。**默认禁用**，要用得先 `/next-phase on`。
2. **`agent_settled` 监听** — 本轮彻底结束（含自动重试、压缩、排队消息）且存在未派发的交接时，派发内部命令 `/next-phase-run`。
3. **命令 `/next-phase-run`** — `waitForIdle` → `navigateTree` 切到新分支 → 写消费标记 → 注入交接的 `prompt`，下一阶段就此开跑。
4. **`session_start` / `session_tree` 监听** — 沿当前分支找消费标记，决定 `next_phase` 工具的显隐。

两处关键性质：

- **新分支在同一棵 session tree 里**，上下文为空（不含此前的对话），用 `/tree` 一步回得去。代价是交接内容必须落盘成文件——新分支看不到旧对话，`prompt` 里要写清读哪些文件。
- **不需要 finish-task**：结果留在新分支，不自动回灌、不自动返回。

工具显隐是**按分支**的：进了后续阶段的分支就隐藏 `next_phase`，`/tree` 回到标记之前的分支会恢复。

## 配置

| 项 | 说明 |
|---|---|
| `/next-phase on` | 在**当前会话**启用 `next_phase` 工具 |
| `/next-phase off` | 禁用（默认状态） |
| `/next-phase status` | 显示：工具是否激活 / 当前分支处于哪个阶段 / 有无待派发交接 |
| 默认值 | 关闭。`session_start` 与 `/reload` 都会重置为关闭 |

开关按 `sessionId` 隔离：父会话与子代理会话互不影响，子代理里始终是隐藏状态。

## 调试

**单元测试**（零依赖，Node ≥ 22 直接用原生类型剥离跑 TS）：

```bash
node --test pi/extensions/next-phase/logic.test.mts
```

覆盖 `logic.ts` 的三个纯函数：新分支起点、分支阶段判定、待派发交接判定。

**加载验证**（零安装：直接引用 pi 自带的 esbuild，通用流程见 `skills/pi-extension-dev/`）。在**仓库根目录**执行：

```bash
PI_ROOT="$(dirname "$(dirname "$(dirname "$(readlink -f "$(command -v pi)")")")")"
mkdir -p .pi/T/ext-verify/node_modules
ln -sfn "$PI_ROOT/node_modules/typebox" .pi/T/ext-verify/node_modules/typebox
printf 'import ext from "../../../pi/extensions/next-phase/index.ts";\nconsole.log(typeof ext);\n' > .pi/T/ext-verify/verify.ts
node "$PI_ROOT/node_modules/esbuild/bin/esbuild" .pi/T/ext-verify/verify.ts \
  --bundle --platform=node --format=esm \
  --external:@earendil-works/* --external:typebox --outfile=.pi/T/ext-verify/out.mjs
node .pi/T/ext-verify/out.mjs   # 应输出 function
```

**TUI 手动验证剧本**（纯逻辑测不到的部分）：

1. `/reload`，然后 `/next-phase` → 应显示「已隐藏」，且模型工具列表里没有 `next_phase`。
2. `/next-phase on` → 显示「已启用」，然后让模型调用 `next_phase`（例如「这一阶段做完了，交接下一阶段」）。
3. 确认框出现 → 选「是」→ 本轮结束后应自动切到新分支并开始执行交接的 prompt；`/next-phase` 应显示「已隐藏 / 当前分支处于后续阶段」。
4. `/tree` 跳到切分点之前 → `/next-phase` 应显示「已启用 / 当前分支处于初始阶段」（工具恢复）。
5. 选「否」（取消确认）→ 不应发生任何切换，模型继续当前阶段。

## 陷阱

**工具不能自己切会话。** 工具的 `ctx` 是 `ExtensionContext`，`waitForIdle` / `navigateTree` / `newSession` 只在 `ExtensionCommandContext` 上——类型层面就没有。所以切换必须走命令。

**派发不能放在工具里。** 工具里 `sendUserMessage("/cmd", { expandPromptTemplates: true })` 会**立即**执行命令（pi 的 `prompt()` 先处理 slash 命令、再判 streaming），而此时 `navigateTree` 会因 `isStreaming` 直接抛错。派发的唯一安全时机是 `agent_settled`——那里 `isIdle()` 为 true。

**「默认禁用」要主动摘。** 扩展注册的工具会被 pi 自动激活，`session_start` 里不摘掉就等于是默认开启。`/reload` 会重新激活，所以这个摘除动作在每个 `session_start` 都跑一遍。

**工具显隐不随分支持久化。** `pi.setActiveTools` 改的是会话运行时状态，不写 session entry，`/tree` 切分支不会自动恢复。所以显隐完全由 `session_start` / `session_tree` 重算，且 `runHandoff` 在 `navigateTree` 之后要再同步一次——`session_tree` 在新分支上还没有消费标记时就触发了，那一刻工具会被误判为可显示。

**消费标记写在新分支上。** 旧分支上那条 handoff 靠「有没有 START entry 引用它」判断是否已派发，而 START 落在新分支，所以判定要扫全会话（`getEntries()`）而不只是当前分支；否则用户 `/tree` 回到旧分支会把同一个交接再派发一次。

**一次只派发最后一个交接。** 同一轮里排了多个 `next_phase`（模型一次发多个工具调用、都点了确认），派发时只取分支上最后一个未消费的交接，前面的会被丢掉。工具描述里已写「一个阶段边界只排一次」。

**`navigateTree` 被取消时交接保留在队列。** 取消只可能来自其他扩展的 `session_before_tree`，此时不写任何标记，交接会在下次 `agent_settled` 重试。

**子代理会话不会弹窗。** `hasUI` 为 false 时工具直接返回文字说明（这也是守卫用 `ctx.hasUI` 而不是 `ctx.mode` 的原因：RPC 模式有 UI，`mode !== "tui"` 会把 RPC 一并挡掉）。

**单测的警告别去修。** 跑 `.ts` 会出现 `MODULE_TYPELESS_PACKAGE_JSON` 警告，这是仓库 `package.json` 没有 `"type": "module"` 导致的。**不要**为了消除它加这个字段——它会影响 pi 用 jiti 加载扩展的方式。
