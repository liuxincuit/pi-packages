# Repository Guidelines

一个 pi 包：`@liuxincuit/pi-kit`。仓库根就是包根，`extensions/`、`skills/`、`prompts/` 三个约定目录由根 `package.json` 的 `pi` 字段声明。装一台新机器只要 `pi install npm:@liuxincuit/pi-kit`。

## 目录结构

```
extensions/<名字>/index.ts   # 一个扩展一个目录，入口固定 index.ts
skills/<名字>/SKILL.md       # 技能
prompts/*.md                 # 提示词模板
attic/next-phase/            # 停用扩展，不参与加载
openspec/                    # OpenSpec 规格与变更记录（必须在仓库根）
package.json                 # 包定义 + pi 字段 + files 白名单
```

目前 17 个扩展，清单在 `README.md`。

## 扩展约定

- 入口必须是 `extensions/<名字>/index.ts`。`extensions/` 的一层子目录只认 `index.ts`（没有就跳过），所以同目录的辅助模块（`deepseek-web/api.ts`、`skill-manager/scope.ts`）不会被误当扩展加载。反过来，**别在扩展子目录里放 `package.json` 带 `pi.extensions` 字段**，那会覆盖这个发现规则。
- 扩展可以带运行时数据目录：`tree-summaries/builtin/*.md`、`codegraph/docs/`。这类路径必须用 `import.meta.url` 定位（`fileURLToPath(new URL("../x", import.meta.url))`），不能写相对 cwd 或仓库绝对路径，否则从 npm 安装后就找不到。目录层级变了要同步改这些 URL。
- 每个扩展有自己的 `README.md`，写配置、调试步骤、陷阱。改行为的改动要更新它。
- host 提供的包放 `peerDependencies` 且范围为 `"*"`：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-tui`、`typebox`。不要放进 `dependencies`——pi 的 loader 对它们做了 jiti alias，物理副本会造成重复实例。
- 不要加 `"type": "module"` 来消除测试警告——会影响 pi 用 jiti 加载扩展的方式。
- 新增扩展后，同步更新根 `README.md` 的扩展表。

## 技能与提示词

技能放 `skills/<名字>/SKILL.md`，提示词放 `prompts/*.md`，都随包分发，不单独建包。`codegraph` 的 skill 由 `extensions/codegraph/index.ts` 通过 `skillPaths` 指向 `../../skills/codegraph/SKILL.md`，移动该目录要同步改这里。

## 验证与测试

仓库无运行时依赖。纯逻辑单测零依赖直接跑：

```bash
npm test      # node --test "extensions/**/*.test.mts"
```

`node --test` 需要 Node ≥ 22（原生类型剥离 TS）。

验证扩展能否加载，用 **pi 自己的包管理器 + loader**（零安装），要点：

```js
const { loadExtensions } = await import(
  pathToFileURL(join(npmRoot, "@earendil-works/pi-coding-agent/dist/core/extensions/loader.js")).href
);
const result = await loadExtensions(entryPaths, process.cwd());
```

判据是 `result.errors` 为空 **且** `result.extensions.length` 等于预期数量。注意：

- `cwd` 是必填参数，漏传会在 pi 内部抛 `TypeError`。
- 路径必须包成 `file://` URL，Windows 上直接 `import()` 绝对路径会报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
- pi 1.3.0 起安装里不再自带 esbuild，不要用 `esbuild --bundle` 验证。
- 想连 `pi` 字段一起验（`extensions`/`skills`/`prompts` 三个都解析），用一份隔离的 `settings.json` 走 `DefaultPackageManager.resolve()`，别动真实配置。技巧：`os.homedir()` 在 Windows 上读 `USERPROFILE` 不读 `HOME`，隔离要两个都改。

需要 pi 运行时的行为（对话框、切会话、消息注入、UI 渲染）写进对应扩展的 README「调试」节，靠 TUI 手动剧本验证。

`codegraph` 的 `typecheck` / `smoke` 脚本随包结构合并去掉了；`extensions/codegraph/` 里的 `smoke.mjs` 与 `tsconfig.json` 还在，需要时手动跑 `tsc`。

## 发布

只有根一个包，在仓库根执行：

```bash
npm version patch     # 或 minor / major
npm publish
```

不要用 `--workspaces`（仓库已没有 workspace）。发布前：

1. `npm test` 全绿
2. `npm pack --dry-run` 看文件清单，确认没漏运行时文件、也没混进 `*.test.mts` 或开发资产
3. 用隔离 settings 加载一次预期数量的扩展

时序参考：`npm publish` 后 npmjs 上约 5 分钟才可查（提示 "being processed"），npmmirror 随后几分钟内跟上。所以发布后不要立刻 `pi install`，先 `npm view` 轮询。

## 数据目录

扩展运行时数据放在 `~/.pi/agent/extensions/<扩展名>/`，项目级放在 `<cwd>/.pi/<扩展名>/`。**目录名是扩展的稳定标识，不要随包名或代码目录改名**：`skill-manager` 的数据目录固定为 `pi-skills`（见 `extensions/skill-manager/scope.ts`），改名会丢配置和用量记录。

## 与 npm 安装的关系

仓库根既是包根，也是本机的本地路径包。**同一台机器上不要同时配 `D:/code/pi-packages` 和 `npm:@liuxincuit/pi-kit`**——pi 按本地绝对路径和 npm 包名识别为两个身份，会各加载一次，工具重名。

- 改代码的机器：`pi install .`，改完 `/reload` 立即生效
- 只消费的机器：`pi install npm:@liuxincuit/pi-kit`，改完的机器 bump 版本发布后，那边 `pi update --extensions`

## 提交约定

- Conventional Commits，作用域写扩展名或 `repo`，例如 `feat(costtime): ...`、`fix(deepseek-web): ...`、`refactor(repo): ...`。
- 只提交自己修改的文件；不要提交 `node_modules`、`.tmp`、`.smoke-build`、`.pi`（会话输入历史）。
- 切勿提交 API Token、密钥或凭证。
- 更新已发布版本时保持向后兼容，或明确记录破坏性变更。
