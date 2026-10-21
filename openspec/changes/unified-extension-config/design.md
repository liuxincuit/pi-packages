# Design

## Context

动机见 `proposal.md` — Why。这里只记实现决策所依赖的现状与实测事实。

### 现状：五套读取逻辑，零共享代码

| 扩展 | 全局配置 | 项目配置 | 读取时机 | 写回 |
|---|---|---|---|---|
| `deepseek-web` | `extensions/deepseek-web/config.json` | 无 | 扩展加载时一次 | 否 |
| `subdir-context` | `extensions/subdir-context/config.json` | `.pi/extensions/subdir-context/config.json` | 每次 `read` 工具调用 | 否 |
| `codegraph` | `extensions/pi-codegraph/config.json` | `.pi/extensions/pi-codegraph/config.json` | 每次构造提示时 | 否 |
| `skill-manager` | `extensions/pi-skills/config.json` | `.pi/extensions/pi-skills/config.json` | 每次读取设定时 | 是 |
| `auto-prepend` | `auto-prepend.json`（agent 根） | 无 | `session_start` 与命令 | 是（`/init`） |

四份实现各自 `JSON.parse` + `try/catch`，合并逻辑分别是一份、并集、浅覆盖、三层。

### 实测事实（pi 1.3.0）

**1. 宿主没有扩展配置 API。** `ExtensionContext` 的 19 个自有成员里没有配置读取入口，扩展只能自己读文件。`deepseek-web/config.ts` 的注释「pi 没有第三方扩展配置 API」在当前版本仍然成立。

**2. 扩展发现规则决定共享模块能放哪。** `discoverExtensionsInDir()` 三条规则：

```
extensions/
  foo.ts              <- 规则1：裸 .ts/.js 文件直接被当扩展加载
  bar/index.ts        <- 规则2：子目录有 index.ts 才加载
  baz/package.json    <- 规则3：子目录有 pi 清单才加载
  _shared/kit.ts      <- 无 index.ts、无 pi 清单元数据 -> 跳过（唯一安全位置）
```

结论：共享模块必须放在**子目录内的文件**，且该子目录不能有 `index.ts`，也不能有带 `pi` 字段的 `package.json`。

**3. jiti 只为包名做 alias，相对路径走标准解析。**

`getAliases()` 只映射 `@earendil-works/*`、`typebox` 等包名，不含任何路径限制。跨目录相对 import 没有被拦截的理由，但由于没有实测过，仍列为风险。

**4. 模块实例的共享范围。** 每个扩展入口由独立的 jiti 实例加载（`loadExtensionModule` 里每次新建），且 `moduleCache: false`。同一扩展内部，其子模块在该实例内只求值一次；跨扩展是否同一实例没有保证。因此共享模块**不能承载跨扩展的可变状态**。

**5. pi 自己的 `settings.json` 写回是字段级读改写**，未知键会保留。理论上可以借它承载扩展配置，但见 Decisions 第 4 条。

## Goals / Non-Goals

**Goals**

- 五个扩展共用一份配置读取实现，路径与合并语义只有一处定义
- 项目级覆盖能力按分区、按键显式开放，默认关闭
- 单文件的读写不互相踩：写入只影响目标分区，读到坏数据只降级该分区
- 纯逻辑可 `node --test`，不需要 pi 运行时

**Non-Goals**

- 不提供配置的 UI/编辑器，也不做 `/kit` 查看命令
- 不迁移状态数据（`usage.jsonl`、`input-history`、`profiles/`）
- 不把 `.env`、prompt 片段、rules 目录塞进 JSON
- 不做旧路径的兼容读取层
- 不追求配置热重载的推送通知：只保证「下次读取拿到新值」

## Decisions

### 1. 配置文件放 `extensions/pi-kit/config.json`

`<agentDir>/extensions/pi-kit/config.json`（全局）与 `<cwd>/.pi/extensions/pi-kit/config.json`（项目）。

与 `skill-manager` 现有的 `extensions/pi-skills/config.json` 规则同构，只是换了一个名字，不引入新惯例；`pi-kit` 取自包名 `@liuxincuit/pi-kit`，与 `pi-skills`、`pi-codegraph` 的命名风格一致。

*替代方案*：`<agentDir>/kit.json`（与 `auth.json`、`models.json` 同级）。否掉的原因是与既有扩展数据目录惯例脱节，且 `auto-prepend.json` 这种散落在 agent 根的做法正是本次要去掉的形态。

*替代方案*：`<agentDir>/extensions/kit/config.json`。否掉是因为少一个 `pi-` 前缀会让它与「扩展目录」的命名风格不一致，无法一眼区分。

### 2. 分区键等于扩展在 `extensions/` 下的目录名

`codegraph`、`skill-manager`、`deepseek-web`、`subdir-context`、`auto-prepend`。

这样「我要改 X 扩展」到「写哪个 key」不需要额外记忆，也不必查注释。

*代价*：`skill-manager` 的数据目录仍是 `pi-skills`（`AGENTS.md` 规定目录名是稳定标识，改名会丢 `usage.jsonl` 与配置），所以配置 key 与数据目录名继续不一致。这是本次唯一保留的不一致，靠文档写明映射关系。

*替代方案*：沿用 `pi-skills`、`pi-codegraph` 作 key。否掉，因为这等于把历史遗留的不一致固化进新格式。

### 3. 共享模块放 `extensions/_shared/kit-config.ts`

一个纯函数 + 少量文件 IO 的模块，不 import pi 运行时（`getAgentDir()` / `CONFIG_DIR_NAME` 由调用方传入或用字符串常量），因此可以直接被 `node --test` 覆盖。

*替代方案*：每个扩展内联一份读取逻辑。否掉——这正是现状的问题来源，5 份实现会在半年内重新漂移。

*替代方案*：单独发一个 npm 包 `@liuxincuit/pi-config`。否掉，两个包的版本需要对齐，发布成本换不来收益。

*替代方案*：放在 `extensions/kit-config.ts`（裸文件）。否掉——loader 规则 1 会把它当扩展加载。

### 4. 不借用 pi 的 `settings.json`

虽然它有两级合并、字段级读改写保留未知键，但它不是扩展的配置通道：`ExtensionContext` 不暴露它，扩展只能自己解析，等于依赖宿主的文件格式与内部字段语义。宿主要改格式或加校验时，扩展会被动断裂。

### 5. 合并：分区内深合并，数组替换

```ts
merge(global, project) = { ...global, ...project }   // 逐键递归，数组整体替换
```

数组不做并集，因为「项目里删掉一条全局配置」在并集语义下无法表达。`subdir-context` 从并集改为替换是本次唯一的语义变更。

*替代方案*：给数组支持 `"+item"` 前缀表示增量。可以做到，但当前没有真实需求，先不做。

### 6. 项目级覆盖能力用显式白名单表，默认拒绝

```ts
const SECTIONS = {
  "deepseek-web":   { projectOverridable: [] },
  "codegraph":      { projectOverridable: ["extraTools", "inject"] },
  "subdir-context": { projectOverridable: ["extraRoots"] },
  "skill-manager":  { projectOverridable: ["skills"] },
  "auto-prepend":   { projectOverridable: ["enabled", "interval", "message"] },
};
```

安全理由：`deepseek-web` 的 `apiKey` 在全局，若允许项目改 `baseURL`，一个已受信任的恶意仓库就能把带 key 的请求导向第三方。把「哪些键可被项目改写」变成代码里可审查的清单，比依赖「用户会仔细看项目配置」可靠。

*替代方案*：整个分区要么全可覆盖要么全不可覆盖。否掉——`auto-prepend` 的消息文案天然跟项目走，而它是同一个分区。

*替代方案*：敏感字段黑名单（`apiKey` 不可覆盖）。不如白名单安全，新增字段默认落到「可覆盖」侧。

### 7. 项目级只在 `ctx.isProjectTrusted()` 时读取

与 `codegraph`、`skill-manager`、`tree-summaries` 现有做法一致。`subdir-context` 目前漏了这个判断，接入共享模块时一并补上。

信任判断由调用方在读取时传入，共享模块本身不碰 `ctx`，保持可单测。

### 8. 写回：读改写的原子替换，不加锁

只改目标分区的目标键，其余内容原样保留；写临时文件后 `rename` 覆盖，避免读到半截文件。

不引文件锁：pi 是单进程，写回只发生在用户执行命令的瞬间（`/skills disable`、`/auto-prepend init`），不存在竞争写入者。

*替代方案*：引 `proper-lockfile`。否掉——它是 pi 的依赖，不是本包的，且此处没有并发场景。

### 9. 不做读写缓存

每次读取都重新 `readFileSync` + `JSON.parse`。配置文件是几 KB 量级，代价可忽略；换来的是「改动即时生效」这条契约无条件成立，也不必在 `moduleCache: false` 下推理缓存生命周期。

### 10. 不做旧路径兼容

旧路径不读、不警告、不回落。本机只有三份文件需要迁（`deepseek-web/config.json`、`pi-skills/config.json`、`auto-prepend.json`），一次性搬完比维护一条 shim 便宜；shim 还会制造「为什么我改了旧文件没生效」这类排查点。

### 11. 错误按段隔离

```
整个文件 JSON.parse 失败
  -> 所有分区当未配置，扩展用默认值，加载不失败
单个分区不是对象
  -> 只有该分区当未配置
分区内某字段类型不对
  -> 共享层原样交出，由扩展自己校验（deepseek-web 的 baseURL 形状检查保留）
```

共享层不校验字段语义，这样每个扩展的错误文案可以贴着自己的领域写。

## Risks / Trade-offs

**跨目录相对 import 在 jiti 下的解析行为未实测** → 第 1 阶段就写共享模块并用 pi loader 批量加载验证；若失败，退化为每个扩展内联一份（spec 不变，只是重复代码）。

**`_shared/` 被误当扩展加载** → 该目录内只放 `kit-config.ts` 与其测试，绝不放 `index.ts` 或带 `pi` 字段的 `package.json`；`AGENTS.md` 写明这条。

**单文件写回放大风险**：`skill-manager` 每切一个开关都重写整个文件，写坏会连带 `apiKey` → 原子写 + 「只改目标分区」的测试覆盖；迁移前把旧文件内容备份一份到 `.tmp/` 作为回滚材料（不作为任何配置引用）。

**项目级配置文件失效**：其他仓库里已存在的 `.pi/extensions/*/config.json` 会静默不再被读 → README 与 `AGENTS.md` 明确写出断裂；本仓库当前没有这类文件，本机也没有。

**`subdir-context` 的 `extraRoots` 语义变更** → 在 proposal 里已标为 BREAKING；本机全局与项目两层目前都没有该配置，实际零影响。

**配置 key 与数据目录名继续不一致** → 文档写明 `skill-manager` ↔ `pi-skills` 的映射，且只在迁移说明里出现一次。

## Migration Plan

分三阶段，每阶段可独立验收：

1. **共享模块 + 单测**：新增 `_shared/kit-config.ts` 与测试，不动任何扩展行为。验收 `npm test` 全绿 + pi loader 加载本包仍报 `errors: []`。
2. **逐个接入**：`deepseek-web` → `subdir-context` → `codegraph` → `skill-manager` → `auto-prepend`。每个扩展接入后跑一次 loader 验证，避免五个一起改完才排查。
3. **本机迁移 + 文档**：合成 `pi-kit/config.json`，删三份旧文件（保留 `pi-skills/usage.jsonl`），删空的 `deepseek-web/` 目录，更新 `AGENTS.md`、`README.md` 与四个扩展 README。

回滚：代码 `git revert` 即可；配置侧迁移前把三份旧文件备份到 `.tmp/unified-extension-config-backup/`，回滚时拷回。

## Open Questions

- `subdir-context` 的 `extraRoots` 是否值得加 `"+item"` 增量语法。等真实需要时再定，当前不影响任何 spec。
- 若宿主将来提供扩展配置 API，是否把读取层换成它。届时只需改共享模块内部，分区格式可保持不变。
