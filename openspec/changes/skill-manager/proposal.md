# Proposal

## Why

pi 里 skill 的可用性目前只能靠三件事改变：删掉目录、改 `SKILL.md` 的 frontmatter、或重启进程。用户无法在不改文件、不重启的前提下让模型停止看到某个 skill。当技能数量增长到二十多个时，路由噪音和维护成本全部落在用户身上。

## What Changes

- 新增 `skill-manager` 扩展，注册 `/skills` 命令
- `/skills` 打印文本表：名称、模型可见性、来源、当前状态。输出只走 `ctx.ui.notify`，不进入模型上下文
- `/skills disable|enable <name>` 省略作用域时作用于当前会话；`--project` / `--global` 切换层级
- 禁用在模型请求构建前生效：过滤 `before_agent_start` 的 `systemPromptOptions.skills`。不需要 `/reload`，不改动任何 skill 文件
- 三层作用域按 `会话 > 项目 > 全局` 合并，每层三态（禁用 / 启用 / 未提及）。三态是必需的，否则「全局禁用、本项目启用」无法表达
- 全局配置存 `<agentDir>/extensions/pi-skills/config.json`，项目配置存 `<cwd>/.pi/extensions/pi-skills/config.json`
- 项目级配置仅在项目受信任时读取
- 被禁用的 skill 仍可通过 `/skill:name` 显式调用；本 change 不改变命令注册，也不修改 skill 的发现逻辑

## Capabilities

### New Capabilities
- `skill-management`: 查看已加载 skill 的清单与来源，并在会话、项目、全局三个作用域内禁用或启用单个 skill，使被禁用的 skill 不再出现在系统提示中

### Modified Capabilities
（无）

## Impact

- 新增代码：本仓库以 pi package 形式提供扩展入口（`package.json` 声明 `pi.extensions`）
- 新增用户级配置：`<agentDir>/extensions/pi-skills/config.json`
- 新增项目级配置：`<cwd>/.pi/extensions/pi-skills/config.json`
- 依赖 pi 内部行为：`ExtensionCommandContext.getSystemPromptOptions()`（运行时存在，TS 类型未声明）与 `before_agent_start` 的 `systemPromptOptions.skills` 可变性。两者已在 pi 1.1.0 实测确认
- 不修改 pi 自身的 settings、任何 `SKILL.md`、或 skill 发现逻辑
