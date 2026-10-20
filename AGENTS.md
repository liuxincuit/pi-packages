# Repository Guidelines

pi 插件集合。每个插件一个独立 npm 包，放在 `packages/<kebab-case-name>/`，可以单独安装，不互相捆绑。

## 目录结构

```
packages/                 # 只放插件，每个子目录一个独立 pi 包
  ask-user-question/      # 包名 @liuxincuit/pi-ask-user-question
  ...
  codegraph/              # @liuxincuit/pi-codegraph，保持原仓库布局
  skill-manager/          # @liuxincuit/pi-skills，保持原仓库布局
skills/                   # 技能，不是插件；新增技能直接放这里，不要建包
prompts/                  # 提示词模板，同样不是插件，不建包
attic/next-phase/         # 停用扩展，不是包、不参与加载
openspec/                 # OpenSpec 规格与变更记录（必须在仓库根）
package.json              # workspaces 根 + 资源包：声明 pi.skills 与 pi.prompts，不声明 extensions
```

根 `package.json` 只声明 `pi.skills` 与 `pi.prompts`，不声明 `pi.extensions`：它是工作区入口兼资源包，加载根路径只会带来技能与提示词。

## 包约定

- 技能与提示词不是插件：技能放仓库根 `skills/`，提示词放仓库根 `prompts/`，由根 `package.json` 统一声明。不要为单个技能或提示词新建包。
- 一个包一个扩展，入口为包根的 `index.ts`，由包内 `package.json` 的 `pi.extensions` 显式声明。
- `codegraph` 和 `skill-manager` 是两个例外：保留各自原仓库的目录布局与 `pi` 字段，因为它们已经发布到 npm，改动包内路径会影响升级。
- `solution`、`private: true` 表示暂不发布。已发布的两个包（`@liuxincuit/pi-codegraph`、`@liuxincuit/pi-skills`）不要加 `private`。
- `files` 必须列出运行时需要的全部文件。带辅助模块的包（`deepseek-web` 的 `api.ts/config.ts/logic.ts`、`tree-summaries` 的 `logic.ts/builtin/`）不能只写 `index.ts`，否则发布后运行时缺文件。
- host 提供的包放 `peerDependencies` 且范围为 `"*"`：`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`@earendil-works/pi-agent-core`、`@earendil-works/pi-tui`、`typebox`。不要放进 `dependencies`。
- 不要给包加 `"type": "module"` 来消除测试警告——会影响 pi 用 jiti 加载扩展的方式。

## 验证与测试

仓库无运行时依赖。验证扩展用 **pi 自己的 loader 批量加载**（零安装）：

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

纯逻辑单测零依赖直接跑：

```bash
npm test                      # node --test "packages/**/*.test.mts"
```

`node --test` 需要 Node ≥ 22（原生类型剥离 TS）。需要 pi 运行时的行为（对话框、切会话、消息注入、UI 渲染）写进对应包的 README「调试」节，靠 TUI 手动剧本验证。

修改 `codegraph` 后额外跑：

```bash
npm run typecheck --workspace=@liuxincuit/pi-codegraph
npm run smoke --workspace=@liuxincuit/pi-codegraph
```

## 发布

只发布明确要发的包，按需执行，不要用 `npm publish --workspaces`：

```bash
npm publish --workspace=@liuxincuit/pi-codegraph
npm publish --workspace=@liuxincuit/pi-skills
```

新包去掉 `private: true` 后才能发布。版本各自独立，用 `npm version <patch|minor|major> --workspace=<包名>`。发布前必须用 loader 验证加载，并用 `npm pack --workspace=<包名>` 检查 tarball 内容没有漏文件。

## 数据目录

扩展运行时数据放在 `~/.pi/agent/extensions/<扩展名>/`，项目级放在 `<cwd>/.pi/<扩展名>/`。**目录名是扩展的稳定标识，不要随包名或代码目录改名**：`skill-manager` 的数据目录固定为 `pi-skills`（见 `packages/skill-manager/pi/extensions/skill-manager/scope.ts`），改名会丢配置和用量记录。

## 提交约定

- Conventional Commits，作用域写包名，例如 `feat(costtime): ...`、`fix(deepseek-web): ...`、`chore(repo): ...`。
- 只提交自己修改的文件；不要提交 `node_modules`、`.tmp`、`.smoke-build`。
- 切勿提交 API Token、密钥或凭证。
- 更新已发布包时保持向后兼容，或明确记录破坏性变更。
