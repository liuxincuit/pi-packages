# Proposal

## Why

`.pi/skills` 装得越来越多，但没有任何办法知道哪些真的在用、哪些装了从来没碰过。`/skills` 只回答「有什么」，不回答「用得多不多」。用户只能凭印象决定删哪个，而删错一个还在用的 skill，代价不可逆——下次做同类任务时模型不会再去加载它。

## What Changes

- 新增 `/skills stats` 子命令，输出按 3 天 / 7 天 / 1 月 / 3 月 / 半年五个滚动窗口统计的 skill 调用次数表。
- 新增实时采集：扩展挂两个通知型事件钩子，在 skill 被调用时把一条记录追加到本机日志。**不回填历史**——统计从本机日志中最早一条记录起算，不追溯该记录之前的调用。
- 新增本机日志文件，记录每次 skill 调用的事件（时间、通道、SKILL.md 路径、会话、cwd）。
- 修改 `/skills` 的一级参数补全候选，加入 `stats`。
- 列表输出仍然只进终端，不写入模型上下文（沿用现有约束）。

**不做的事**：不回填安装前的历史；不做跨机器同步；不统计 `read` 之外的加载方式（如 `bash cat`）；不区分 skill 来源层级的用量。

## Capabilities

### New Capabilities

- `skill-usage-tracking`: 记录本机上每次 skill 调用并按滚动时间窗口聚合展示，统计起点为本机日志中最早一条记录。

### Modified Capabilities

- `skill-management`: `命令参数补全` 这一条 requirement 的一级候选从只有 `list`、`disable`、`enable`，变为同时包含 `stats`。

## Impact

**代码**

- 新增 `pi/extensions/skill-manager/usage.ts`：日志的追加、读取与窗口聚合。按现有约定不 import pi 运行时，可直接 `node --test`。
- 新增统计表渲染（复用现有 `render.ts` 的显示宽度对齐逻辑）。
- 修改 `pi/extensions/skill-manager/index.ts`：注册两个事件钩子，`/skills` 增加 `stats` 分支。
- 修改 `pi/extensions/skill-manager/complete.ts` 与其测试：一级候选加 `stats`。

**运行时状态**

- 新增 `<agentDir>/extensions/pi-skills/usage.jsonl`，append-only 追加。与现有 `config.json` 同目录，不冲突。

**依赖**

- 无新增依赖。用到 pi 已公开导出的 `parseSkillBlock`。

**兼容性**

- `/skills`、`/skills disable`、`/skills enable` 的现有行为不变。
- 日志文件不存在或损坏时，统计表退化为「全部无记录」，不影响其余命令。
