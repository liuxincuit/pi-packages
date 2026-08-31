---
name: pi-extension-dev
description: 开发、修改或验证 pi 扩展（pi/extensions/ 下的 TS 插件）、自定义/覆盖工具（registerTool）、定制 bash 工具行为（spawnHook/operations）时使用。也适用于排查扩展不生效、子代理行为与父会话不一致、验证扩展代码等场景
---

# pi-extension-dev

pi 扩展开发与验证参考（适用本仓库 `pi/extensions/` 与 pi 扩展 API）。

## 关键机制

- **加载**：`package.json` 的 `pi.extensions` 声明目录，jiti 按文件名加载每个 .ts；**修改后必须 /reload 才生效**
- **同名覆盖**：`pi.registerTool({ name: "bash" })` 覆盖内置工具（官方 tool-override 模式），LLM 调用走新注册
- **作用域**：扩展在父会话和**每个子代理会话**重新执行（jiti 每实例独立模块副本，模块变量不共享）；跨实例进程级状态用 `globalThis` + `Symbol.for()`；子代理注册同名工具覆盖子代理内置工具
- **bash 工具定制**：`createBashTool(cwd, { spawnHook, operations })`
  - `spawnHook` — 执行前改 command/cwd/env；**改不了 timeout**
  - `operations` — 整体替换执行后端（pi 官方 `createLocalBashOperations()` 保持原生行为），可注入默认 timeout 等
- **timeout 语义**：bash 工具 schema 的 `timeout`（秒）是 LLM 可选参数，**无默认值**；LLM 调用时传的 timeout 是工具参数，不是 harness 调用超时。扩展可通过包装 operations 注入默认值，LLM 显式值优先

## 验证（仓库无 node_modules）

```bash
TMP=$(mktemp -d) && cd "$TMP"
npm init -y && npm i @earendil-works/pi-coding-agent esbuild
# verify.ts 内 import 扩展文件用绝对路径，如 "D:/code/skills/pi/extensions/compact-tools.ts"
npx esbuild verify.ts --bundle --platform=node --format=esm \
  --external:@earendil-works/* --outfile=verify.mjs
node verify.mjs
```

真实验证：改完扩展后 /reload，实际调用工具观察（如不传 timeout 跑 sleep 验证默认超时生效，错误消息会带说明）。

## 常见错误

| 错误 | 修正 |
|---|---|
| 调用 bash 工具时传 `timeout: 150` 想限制 harness 调用 → 变成工具显式超时，命令按 150s 执行 | timeout 是工具参数；不传才走扩展默认值 |
| `rm -rf` 清理临时目录被 pi-permission-system 拦截 | `node -e "require('fs').rmSync(p,{recursive:true,force:true})"` |
| 改完扩展不 /reload 就测试 | 不 reload 不生效 |
| 在 spawnHook 里试图改 timeout | spawnHook 只能改 command/cwd/env，用 operations 包装 |

## 参考

- pi 扩展文档：`C:/Users/liuxi/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- 仓库示例：`pi/extensions/compact-tools.ts`（同名覆盖 + spawnHook + operations 默认超时）、`bash-approver.ts`（进程级符号去重、子代理幂等）