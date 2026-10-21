# Proposal

## Why

仓库里 17 个扩展中有 5 个各自维护配置文件，路径、目录名与合并语义三处都不统一：

- **路径分散**：全局配置散落在 `extensions/deepseek-web/`、`extensions/pi-skills/`、`extensions/pi-codegraph/` 三个数据目录，外加 agent 根目录下的 `auto-prepend.json` 一个孤例
- **目录名不等于扩展名**：`pi-skills` 对应 `skill-manager`，`pi-codegraph` 对应 `codegraph`。用户改配置前得先猜
- **合并语义各不相同**：`subdir-context` 的 `extraRoots` 是全局与项目并集，`codegraph` 是浅覆盖，`skill-manager` 是会话 > 项目 > 全局三层，`deepseek-web` 与 `auto-prepend` 只有全局

结果是「改一个配置」这件事需要先建立一张扩展名到目录名到合并规则的映射表，而这张表只存在于各扩展的源码注释里。

## What Changes

- 新增全局配置 `<agentDir>/extensions/pi-kit/config.json`，五个扩展的配置按**扩展目录名**分区放进同一文件
- 新增项目级配置 `<cwd>/.pi/extensions/pi-kit/config.json`，仅在项目受信任时读取
- 统一合并语义：分区内深合并、项目覆盖全局、数组替换（不并集）
- 每个分区**显式声明**项目级允许覆盖的键；未声明的键一律只认全局。`deepseek-web` 整段锁死全局，避免恶意项目的 `baseURL` 把全局 `apiKey` 导走
- 新增共享读取模块 `extensions/_shared/kit-config.ts` 与对应单测，承担路径解析、两级读取、分区白名单、按段隔离的错误降级、原子写回
- **BREAKING**：以下路径不再被任何扩展读取
  - `<cwd>/.pi/extensions/pi-skills/config.json`
  - `<agentDir>/extensions/pi-skills/config.json`
  - `<agentDir>/extensions/deepseek-web/config.json`
  - `<agentDir>/extensions/pi-codegraph/config.json`
  - `<agentDir>/auto-prepend.json`
- **BREAKING**：`subdir-context` 的 `extraRoots` 由「全局与项目并集」改为「项目替换全局」
- `skill-manager` 的 `usage.jsonl` 留在 `<agentDir>/extensions/pi-skills/` 不动——它是状态数据，不属于配置

本次不合并、也不改动以下内容，它们不是配置：`<agentDir>/.env`（子进程环境变量）、`tree-summaries/*.md`、`rules-context/rules/`、`usage.jsonl`、`.pi/input-history/`、`<agentDir>/profiles/`。

## Capabilities

### New Capabilities

- `extension-config`: 扩展的统一配置契约——文件位置与分区命名、全局与项目两级合并、项目级覆盖白名单、项目信任门禁、配置缺失或损坏时的降级与写回原子性

### Modified Capabilities

- `skill-management`: 「项目级开关写入项目配置」与「全局级开关写入全局配置」两条 requirement 里写死的 `pi-skills` 路径改为统一的 `pi-kit` 路径

## Impact

**代码**

| 文件 | 动作 |
|---|---|
| `extensions/_shared/kit-config.ts` | 新增 |
| `extensions/_shared/kit-config.test.mts` | 新增 |
| `extensions/deepseek-web/config.ts` | 改读共享分区的 `deepseek-web` 段 |
| `extensions/subdir-context/index.ts` | 删除自有 `configPaths`，改读共享分区 |
| `extensions/codegraph/index.ts` | 删除 `CONFIG_REL_PATH` / `loadCgConfig` |
| `extensions/skill-manager/scope.ts` | 路径函数收进共享模块，写回改原子读改写 |
| `extensions/auto-prepend/index.ts` | 改读共享分区，`/init` 改为 upsert 自有分区 |

**文档**：`AGENTS.md`、`README.md`、`extensions/{deepseek-web,subdir-context,codegraph,skill-manager,auto-prepend}/README.md`

**本机数据迁移**：合成 1 个新文件，删除 3 个旧配置文件（`deepseek-web/config.json`、`pi-skills/config.json`、`auto-prepend.json`），保留 `pi-skills/usage.jsonl`。`pi-codegraph/` 目录在本机不存在，无需处理。

**依赖**：不新增运行时依赖。共享模块只用 node 标准库，路径通过宿主导出的 `getAgentDir()` 与 `CONFIG_DIR_NAME` 求值。

**已知语义变更**：`subdir-context` 的 `extraRoots` 从并集改为替换，三个扩展的项目级配置路径改变。
