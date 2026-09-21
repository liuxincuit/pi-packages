---
name: pi-extension-dev
description: 开发、修改或验证 pi 扩展（pi/extensions/ 下的 TS 插件）、自定义/覆盖工具（registerTool）、定制 bash 工具行为（spawnHook/operations）、切会话与会话树操作（navigateTree/newSession/fork、工具默认禁用与显隐）时使用。也适用于排查扩展不生效、子代理行为与父会话不一致、验证扩展代码等场景
---

# pi-extension-dev

pi 扩展开发与验证参考（适用本仓库 `pi/extensions/` 与 pi 扩展 API）。

## 关键机制

- **加载**：`package.json` 的 `pi.extensions` 声明目录；pi 只扫该目录一层——取顶层 `*.ts`/`*.js`，以及子目录的 `index.ts`（不递归，子目录内其他 .ts 不加载），jiti 逐个加载入口；**修改后必须 /reload 才生效**
- **同名覆盖**：`pi.registerTool({ name: "bash" })` 覆盖内置工具（官方 tool-override 模式），LLM 调用走新注册
- **作用域**：扩展工厂函数在父会话和每个子代理会话都会重新执行，但**模块只 import 一次**（`loader.js` 按路径缓存 factory），所以**顶层模块变量在父会话与所有同 cwd 的子会话之间共享**——并发子代理会互相踩，需要按 `ctx.sessionManager.getSessionId()` 隔离。仅 `/reload` 或子代理换 cwd 时会重新加载模块。跨扩展取值走 `globalThis` + `Symbol.for()`；子代理注册同名工具覆盖子代理内置工具
- **bash 工具定制**：`createBashTool(cwd, { spawnHook, operations })`
  - `spawnHook` — 执行前改 command/cwd/env；**改不了 timeout**
  - `operations` — 整体替换执行后端（pi 官方 `createLocalBashOperations()` 保持原生行为），可注入默认 timeout 等
- **timeout 语义**：bash 工具 schema 的 `timeout`（秒）是 LLM 可选参数，**无默认值**；LLM 调用时传的 timeout 是工具参数，不是 harness 调用超时。扩展可通过包装 operations 注入默认值，LLM 显式值优先

## 会话控制与会话树

扩展想切会话（新建会话、跳分支、fork）时，这几条决定了能怎么写：

- **会话控制方法只挂在命令上下文上**：`waitForIdle` / `navigateTree` / `newSession` / `fork` / `switchSession` 属于 `ExtensionCommandContext`。工具 `execute` 的 `ctx` 是 `ExtensionContext`，事件处理器、快捷键拿到的也是它——**工具不可能自己切会话**。
- **工具里派发命令是「立即执行」**：`pi.sendUserMessage("/cmd", { expandPromptTemplates: true })` 会在**当前工具调用内部**同步跑命令处理器（`expandPromptTemplates` 默认 false，不传根本不派发命令）。此时 agent 正在 streaming：`navigateTree` 直接抛 `Wait for the current response to finish before navigating the session tree.`，命令里的 `waitForIdle()` 会死锁。
- **安全派发点是 `agent_settled`**：那时 `ctx.isIdle()` 已为 true（pi 先置 `_isAgentRunActive = false` 再发事件），`waitForIdle()` 立即返回、`navigateTree` 可用。推荐链路：工具落盘一个「待执行」entry → `agent_settled` 里 `pi.sendUserMessage("/内部命令", { expandPromptTemplates: true })` → 命令里切分支 + 注入 prompt。工具返回 `terminate: true` 可跳过本轮多余的 LLM 调用（取消路径别加，否则模型没机会继续干活）。
- **`pi.appendEntry` 不返回 entry id**，且切分支之后写的 entry 落在**新分支**上。跨分支记账不能靠「就地更新」，要用「引用对方 id」：比如 START entry 的 data 里记 handoffId，判断是否已消费时扫全量 `getEntries()` 而不是当前分支——否则用户 `/tree` 回到旧分支会把同一件事再做一次。
- **工具显隐是运行时状态**：`pi.setActiveTools()` 不写 session entry，`/tree` 切分支**不会**自动恢复。要按分支显示不同工具集，得在 `session_start` / `session_tree` 里自己重算（注意 `navigateTree` 之后新分支还没写标记，需要再同步一次）。
- **扩展注册的工具会被自动激活**（reload 亦然）。「默认禁用」要在 `session_start` 里 `pi.setActiveTools(pi.getActiveTools().filter((n) => n !== NAME))` 主动摘掉，且每次都跑。

参考实现：`pi/extensions/next-phase/`（工具 + 内部命令 + `agent_settled` 派发 + 按分支显隐的完整例子）。

## 验证（仓库无 node_modules）

**零安装路线**：pi 自带的 `node_modules` 里已经有 esbuild / typebox / jiti，直接引用，不必再建临时目录 `npm i`。以下命令在**仓库根目录**执行（临时产物都落在 gitignore 的 `.pi/T/` 内）。

```bash
PI_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent"   # pi 包根目录

mkdir -p .pi/T/ext-verify/node_modules
ln -sfn "$PI_ROOT/node_modules/typebox" .pi/T/ext-verify/node_modules/typebox
# 扩展入口用相对仓库根的路径，改 <name> 即可
printf 'import ext from "../../../pi/extensions/<name>/index.ts";\nconsole.log(typeof ext);\n' > .pi/T/ext-verify/verify.ts

node "$PI_ROOT/node_modules/esbuild/bin/esbuild" .pi/T/ext-verify/verify.ts \
  --bundle --platform=node --format=esm \
  --external:@earendil-works/* --external:typebox --outfile=.pi/T/ext-verify/out.mjs
node .pi/T/ext-verify/out.mjs
```

`--external:typebox` 让打包跳过它，运行时由 verify 目录下的软链提供。

**这个命令只对「import 全是 type-only」的扩展够用。** 如果扩展 import 了 pi-tui 的运行时值（`Editor`、`Key`、`matchesKey`、`Text`、`visibleWidth`、`wrapTextWithAnsi` 等），`--external:@earendil-works/*` 会让产物在 `node out.mjs` 时报 `Cannot find package '@earendil-works/pi-tui'`；把 pi-tui 也软链进去后，它的传递依赖（`marked`、`get-east-asian-width`…）会一个接一个地报，逐个软链是无底洞。此时改用 esbuild 的 JS API，一次把 `nodePaths` 带上：

```js
// .pi/T/ext-verify/build.cjs —— 用法：PI_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent" node build.cjs <entry.mjs> <out.mjs>
const PI_ROOT = process.env.PI_ROOT;
const esbuild = require(`${PI_ROOT}/node_modules/esbuild`);
const [entry, outfile] = process.argv.slice(2);
esbuild.buildSync({
	entryPoints: [entry], bundle: true, platform: "node", format: "esm",
	nodePaths: [`${PI_ROOT}/node_modules`],          // pi-tui 及其整条依赖都在 pi 自己的 node_modules 里
	external: ["@earendil-works/pi-coding-agent"],   // 只留这一个：对它的 import 通常都是 type-only
	outfile,
});
```

`--node-paths` 是 JS API 专有选项，CLI 上不存在（写了只会报 `Invalid build flag`）。

还要验证 **jiti 的真实加载路径**（入口里的 `import "./logic.js"` 指向 `logic.ts` 这类解析只有 jiti 认）：

```js
// .pi/T/ext-verify/jiticheck.cjs，用 `PI_ROOT="$PI_ROOT" node .pi/T/ext-verify/jiticheck.cjs` 跑
const { createJiti } = require(`${process.env.PI_ROOT}/node_modules/jiti/lib/jiti.cjs`);
const jiti = createJiti(__filename, {
	alias: {  // 扩展 import 的运行时包都得指到 pi 自己的 node_modules，否则 jiti 从扩展文件位置向上找不到
		typebox: `${process.env.PI_ROOT}/node_modules/typebox/build/index.mjs`,
		"@earendil-works/pi-tui": `${process.env.PI_ROOT}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	},
});
console.log(typeof jiti(`${__dirname}/../../../pi/extensions/<name>/index.ts`).default);
```

**纯逻辑单测**（拆出 `logic.ts` 之类的无依赖模块才能这么跑）：

```bash
node --test pi/extensions/<name>/*.test.mts
```

Node ≥ 22 原生剥离 TS 类型，零依赖；测试文件用 `.mts` 后缀避开 `MODULE_TYPELESS_PACKAGE_JSON` 警告，**不要**为此给 `package.json` 加 `"type": "module"`。

**行为验证（需要 UI 的扩展）**：把入口换成 `.mjs`，mock 掉 pi 与 ctx，就能不进 TUI 跑 `execute`：

```js
// .pi/T/ext-verify/behavior.mjs —— 用上面的 build.cjs 打成单文件再 node 跑
import ext from "../../../pi/extensions/<name>/index.ts";
let tool;
const execCalls = [];
const pi = {
	registerTool: (d) => { tool = d; },
	exec: async (cmd, args) => { execCalls.push(args.join(" ")); return { stdout: "", stderr: "", code: 0, killed: false }; },
};
let inputHandlers = [];
let resolvePending;
const ctx = {
	mode: "tui",
	ui: {
		onTerminalInput: (h) => { inputHandlers.push(h); return () => {}; },
		custom: () => new Promise((r) => { resolvePending = r; }),   // 受控 promise：自己决定 UI 何时结束
	},
};
ext(pi);                                                        // 拿到 registerTool 收到的定义，才能调 execute
const run = tool.execute("id", params, undefined, undefined, ctx);
await new Promise((r) => setTimeout(r, 11_000));                  // 等过真实的延时窗口
inputHandlers[0]?.("x");                                         // 模拟一次按键，验证取消分支
resolvePending({ questions: [], answers: [], cancelled: true });
await run;
console.log(execCalls.length, execCalls[0]);
```

`ctx.ui.custom(factory)` 里不必建组件，只返回一个自己控制的 promise —— 这样能验证延时、取消、监听器注销这些时序逻辑（组件渲染另说）。延时是源码里的常量时只能等真实时长，一条 30 秒的脚本换来确定性，比塞进 TUI 里手测划算。`exec` 的 mock 同时留下了真实命令字符串，可以再拿去 `spawnSync` 加 `timeout` 真跑一次，验证命令行拼装（引号、转义、枚举值）。

真实验证：改完扩展后 /reload，实际调用工具观察（如不传 timeout 跑 sleep 验证默认超时生效，错误消息会带说明）。

## 常见错误

| 错误 | 修正 |
|---|---|
| 调用 bash 工具时传 `timeout: 150` 想限制 harness 调用 → 变成工具显式超时，命令按 150s 执行 | timeout 是工具参数；不传才走扩展默认值 |
| 临时目录被 pi-permission-system 拦截 | 拦截原因是**路径在工作目录外**，不是命令模式。把临时目录建在工作目录内（如 `.pi/T/`），或先向用户说明；不要换命令绕过 |
| 用 `readlink -f "$(command -v pi)"` 推导 PI_ROOT → 得到 `~/AppData` | npm 的 `pi.cmd` 包装没指向包目录，改用 `PI_ROOT="$(npm root -g)/@earendil-works/pi-coding-agent"` |
| 扩展 import 了 pi-tui 运行时值，`--external:@earendil-works/*` 打包后 `node out.mjs` 报缺 pi-tui | 换 esbuild JS API + `nodePaths`，见「验证」 |
| 改完扩展不 /reload 就测试 | 不 reload 不生效 |
| 在 spawnHook 里试图改 timeout | spawnHook 只能改 command/cwd/env，用 operations 包装 |
| 在 pi 的 `dist/` 上 `grep -r` 找源码 → 命中 `dist/bundle/chunks/*.js`（esbuild 压缩产物，单行最大 3.9MB），一次喷出 50KB+ 输出 | 加 `--exclude-dir=bundle`——`dist/core/`、`dist/modes/` 下是格式化分文件，可正常 grep/sed；已命中 bundle 时用 `grep -oE ".{0,300}"` 限宽 |
| 工具里直接调 `ctx.navigateTree` / `newSession` 想切会话 | 工具的 ctx 上没有这些方法（只在命令上下文），改用 `agent_settled` 派发内部命令，见「会话控制与会话树」 |
| 工具里 `sendUserMessage("/cmd", { deliverAs: "followUp" })` 想延后执行命令 | slash 命令是**立即执行**的，`deliverAs` 对它无效；还得显式传 `expandPromptTemplates: true`，否则命令根本不被派发 |
| `/tree` 切分支后工具显隐不对 | `setActiveTools` 不持久化、不随分支恢复；在 `session_start` / `session_tree` 里重算 |
| 验证脚本里写 `../../../pi/extensions/...` 被 pi-permission-system 拦成 external_directory | 它把相对路径按 cwd 解析后误判成工作目录外。不要换花样重试，改用工作目录内的绝对路径，或先向用户说明再操作 |

## 参考

- pi 扩展文档：`<pi>/docs/extensions.md`，`<pi>` 是 pi 包根目录（`"$(npm root -g)/@earendil-works/pi-coding-agent"`；用 `readlink -f $(command -v pi)` 推导会得到 `~/AppData`，因为 npm 装的是 `.cmd` 包装）；分文件源码在 `<pi>/dist/core/`、`<pi>/dist/modes/`，避开 `<pi>/dist/bundle/`
- 仓库示例：`pi/extensions/compact-tools/index.ts`（同名覆盖 + spawnHook + operations 默认超时）、`pi/extensions/bash-approver/index.ts`（按 sessionId 逐节点注册 authorizer link）、`pi/extensions/next-phase/`（会话控制 + 工具默认禁用 + 单测）
- 跨扩展取 pi-permission-system 服务：读 `Symbol.for("@gotgenes/pi-permission-system:session-services")` 的 Map，按 sessionId 取值；旧 `Symbol.for("...:service")` 槽自 29.0.0 起已废弃，读它只会静默拿到 undefined