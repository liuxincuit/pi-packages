# pi-graph

一条斜杠命令看清「插件 × 生命周期」的注册全貌：哪些插件挂了哪些事件、注册了哪些工具与命令。

## 做什么

`/pi-graph` 往对话流追加一条 custom entry（不弹临时窗口，重启会话仍可回看），出两张表：

**1. 生命周期 × 插件** —— 按真实执行次序分 7 个阶段（启动与信任 / 输入进入 / 每轮边界 / 上下文与模型请求 / 消息流 / 工具执行 / 会话与杂项），每个事件节点下挂监听它的插件，**名字顺序就是真实派发顺序**。节点后的字母是钩子类型：

| 标记 | 含义 | 例子 |
|---|---|---|
| `O` | 只观察 | `agent_start`、`tool_execution_*` |
| `P` | 改提示词 | `before_agent_start` 可换 systemPrompt |
| `C` | 改消息/工具结果 | `context`、`message_end`、`tool_result` |
| `R` | 改模型请求 | `before_provider_request`、`before_provider_headers` |
| `G` | 可阻断/取消 | `tool_call`、`input`、`session_before_*` |
| `S` | 可续跑 | `turn_end`、`agent_before_settle` 返回 `continue` |
| `K` | 资源声明 | `resources_discover` |
| `T` | 信任决策 | `project_trust` |

表尾另给一份「无人监听」的节点清单。

**2. 插件贡献清单** —— 按加载顺序（= 事件派发顺序）列每个插件的工具 / 命令 / 快捷键 / flags / 渲染器 / 声明的技能·提示词·主题数量。工具名有两种异常标记：暗色的 `名字(未激活)` 表示注册了但不在当前激活集（模型这次看不到），警告色的 `名字(被覆盖)` 表示同名工具被后注册者盖掉了。

表是**注册时的快照**，不含本次会话实际触发了哪些 handler。

## 配置

无。

数据从两条路来：公共 API（`getAllTools` / `getCommands` 带 `sourceInfo`，能归因到插件）+ `ExtensionRunner` 的内部字段（`extensions[i].handlers`，事件归属只有这里有）。实测于 pi 1.1.0，表头会写采集时间与 pi 版本。

entry 带 `format` 字段（当前 `1`）：格式对不上时渲染成一行提示而不是乱画，所以升级 pi-graph 后旧会话里的老表不会崩。

## 调试

1. `/reload` 后敲 `/pi-graph`，看对话流里是否出现那张表。
2. 把窗口拉到 60 / 50 / 40 列各看一眼：不崩、逐格折行（宽度语义见「陷阱」）。
3. 切主题：表应重画（entry 渲染器的 `invalidate()` 清缓存）。
4. 降级路径：`delete globalThis[Symbol.for("pi-graph.state")].runner` 后再敲命令，表头应变成「降级模式」而不是抛错。
5. `/resume` 一个旧会话：历史里的 pi-graph entry 应照常渲染。

不进 TUI 的验证（`.pi/T/ext-verify/`，已被 .gitignore）：

```bash
PI_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent"
node .pi/T/ext-verify/load-check.mjs                     # pi 自带 loader 批量加载全部扩展，看 errors
node .pi/T/ext-verify/behavior.cjs                       # 探针 + 降级路径 + 宽度断言
node .pi/T/ext-verify/build.cjs .pi/T/ext-verify/entry.mjs .pi/T/ext-verify/entry.out.mjs   # esbuild 打包
```

`behavior.cjs` 用 mock 的 runner / pi / 主题跑一遍采集与渲染，并在 100 / 60 / 40 / 30 四档断言每行 `visibleWidth <= 渲染宽度`。

## 陷阱

**探针打的是 pi 的内部原型。** 事件归属没有公共出口，只能给 `ExtensionRunner.prototype` 的 `bindCore` / `setUIContext` / `bindCommandContext` / `createCommandContext` 各套一层，从 `this` 抓存活的 runner 实例。补丁标记挂在 `Symbol.for("pi-graph.patched")` 上，`/reload` 换模块实例后不会重复套娃；四个方法一个都找不到就只记错误、走降级。

**抓最新实例靠的是 `createCommandContext`。** 命令派发走 `agent-session.js` 的 `this._extensionRunner.createCommandContext()`，它在包装清单里，所以执行 `/pi-graph` 前一定会用**当前会话**的 runner 覆盖一次 `state.runner`——子代理会话（各自有 ExtensionRunner）抢占过也没关系。别把它从清单里删掉。

**`globalThis` 上留着最后一次用到的 runner。** 它经 `bindCore` 的闭包间接持有那个 `AgentSession`，进程内最多留一个会话不被回收。有界，接受；真要干净只能在 `session_shutdown` 里清，但那时图已经画完了。

**表头不会崩，但很窄会难看。** pi-tui 渲染时对超宽行是**抛异常**（`Rendered line N exceeds terminal width`），不是截断。所以渲染最后把所有行夹到宽度上限：≥60 列排版正常，窄到前缀+24 列装不下时该行改「前缀独占一行、条目另起一行」的堆叠排版，再窄会被截断（内容不全，但不崩 TUI）。

**会重跑一遍 `resources_discover`。** 为采集技能/提示词/主题声明，`/pi-graph` 用 `reason: "reload"` 再调一次 `emitResourcesDiscover`。该钩子按设计只返回路径，代价很小；但它内部会捕获 handler 抛错并 `emitError`——别人的 handler 有问题时，你会看到一条与 pi-graph 无关的报错。采集失败只影响「资源」那一列，不影响出图。

**同名插件的消歧是启发式的。** 短名优先，撞名补一级上级目录（穿过 `dist` / `node_modules` 这类容器目录），再撞加 `#2`。表里不显示完整路径，所以 `#2` 只保证可区分、不保证可辨认。

**pi 升级后**：新事件自动落进「其他（本版本 pi 新增的节点）」，不会丢；`HOOK` 表里没收录的事件按 `O` 显示语义标记，需要手工补。
