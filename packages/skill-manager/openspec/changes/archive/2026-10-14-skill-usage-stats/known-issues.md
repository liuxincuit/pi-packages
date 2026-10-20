# Known Issues — skill-usage-stats

本文件是 `/skills stats` 落地过程中，各任务评审记录下来的已知问题。它们全部**不阻塞合并**（最终整分支评审逐条 triage 过），此处留档以免随 SDD 工作区一并丢失。

最终修复波已消掉的不再列出。标 `[有意取舍]` 的是明确决定保留的行为，不是待办。

## 代码：边界与健壮性

| 位置 | 问题 | 影响 |
|---|---|---|
| `usage.ts` `parseEvent` | 丢弃未知字段，不是 `serializeEvent` 的无损逆运算 | 事件类型扩展时会静默丢数据 |
| `usage.ts` `normalizeSkillPath` | 前导 `//` 被 `posix.normalize` 折叠 | UNC 路径失真；当前只作分组键，影响有限 |
| `usage.ts` `normalizeSkillPath` | 相对路径 + 空 cwd 会静默返回非绝对路径 | 调用方须保证 cwd 非空；当前调用点传 `ctx.cwd`，满足 |
| `usage.ts` `skillNameOf` | 尾随斜杠输入会返回 `"SKILL.md"` | 经 `isSkillFile` 闸门不可达，属潜在契约缺口 |
| `usage.ts` `aggregate` | `<=` 把恰好 72h 算进窗口；age 为负（未来时间戳）的事件被五个窗口全部计入 | 未规定也无测试；负 age 计为「最近」比丢弃更符合直觉 |
| `usage.ts` `aggregate` | 只判 `Number.isNaN`，不带偏移的 `ts` 写法会被当作本地时间 | 真实写入恒为 `toISOString()`，低风险 |
| `usage.ts` `aggregate` | `lastUsed` 保存 `ts` 原文，同内容不同顺序会得到不同字符串 | 消费者需自行 `Date.parse` |
| `usage.ts` `USAGE_WINDOWS` | 可变数组（plan-mandated） | 无 `Object.freeze` |
| `usage.ts` `appendEvent` | 空 catch 使「日志永久写不进去」完全不可见 | spec 明确要求静默丢弃；加告警是新行为与新的 I/O 面 |
| `usage.ts` `explicitSkillPath` | `message` 为 `null`/`undefined` 时抛 `TypeError` | 接口脆弱，非现实缺陷（调用方传 pi 的 message 对象） |
| `index.ts` 采集钩子 | 同步 `appendFileSync` 阻塞事件循环 | 微秒级，载荷一行短文本；是「不 await I/O」的直接结果 |
| `index.ts` `agent_end` | 之后到达的 `tool_execution_end` 会确定性地丢一条记录 | 仅中断运行中忽略 abort 的工具可达；漏记方向是设计接受的一侧 |
| `index.ts` `agent_end` | 若 `sessionKey(ctx)` 在此抛错，桶不会被 `delete` | 上界为每会话一个短字符串，下次同 id 的 `agent_end` 会回收 |
| `index.ts` stats 分支 | 空 catch 丢弃原因，`buildStats`/`renderStats` 的 `TypeError` 会被报成「统计读取失败。」 | 指向日志而非 bug（plan-mandated 文案） |
| `index.ts` 用法行 | `/skills stats --project` 与 `/skills list --project` 静默忽略多余 token | `[有意取舍]` 控制端裁定不改：spec 未要求，`stats` 是全机器口径，用法行已写明 flag 归属 |
| `usage.ts` 类注释 | `PendingReads` 注释写「会话结束时整体 clear」，实际是逐轮 | 措辞偏松，无正确性风险 |

## 代码：有意保留的行为

| 位置 | 行为 | 理由 |
|---|---|---|
| `isSkillFile` | 精确大小写匹配 `/SKILL.md`，`.../skill.md` 不记录 | `[有意取舍]` spec 用精确写法；方向是假阴性，不会误记 |
| `usage.ts` `normalizeSkillPath` | 不做大小写归一 | `[有意取舍]` Linux 上大小写有语义 |
| `render.ts` 兜底 | 三段全空时输出「没有可展示的统计。」 | spec 无明文措辞；若日后统一文案需同步改测试 |

## 测试：鉴别力与卫生

| 位置 | 问题 |
|---|---|
| `usage.test.mts` | `tmpFile` 每次都 `mkdtempSync` 且不清理，每次跑漏约 5 个空目录 |
| `usage.test.mts` | 「写入失败不抛异常」只断言 `doesNotThrow`，不言「写入确实失败了」；平台行为变化时会静默变假绿 |
| `usage.test.mts` | `isNonEmptyString` 的空字符串分支未被任何用例覆盖 |
| `usage.test.mts` | 恰好 72/168 小时的边界无测试 |
| `usage.test.mts` | 一条 `assert.notEqual` 在夹具现有定义下不可能失败，检查的是夹具自身 |
| `usage.test.mts` | 三条断言挤在同一 `test` 里，失败归属指向同一个测试名 |
| `usage.test.mts` | 「take 未记录过的 id 返回 undefined」是最弱的用例（任何 `Map` 都通过）；真正执行「不提交」的是 `index.ts` 的 `if (!skillPath) return` —— 验收时不要把它当端到端证据 |
| `render.test.mts` | `nameWidth` 比表头窄那条断言靠 `pad` 不缩窄表头间接生效；若 `pad` 日后开始截断会静默失去鉴别力 |
| `render.test.mts` | `>= 62` 行数下界在精确计数落地后已冗余（作为前瞻保留） |
| `render.test.mts` | 测试名声称「返回一行提示」但无断言钉住单行 |
| `render.test.mts` | 用 `trim` 精确比对标题，带装饰的标题（如 `当前加载（0）`）会溜过；该盲区在既有测试里也存在 |
| `render.test.mts` | 无「多个无记录名」用例、无 CJK 名截断用例 —— 可能漏掉「只印第一个名字」与宽字符截断两类坏实现 |
| `complete.test.mts` | 与另一条断言对同一描述重叠（被严格覆盖，保留无害） |
| `complete.test.mts` | 一处注释把短路机制归错分支（`stats --` 实际在第二级就返回空）；结论仍正确 |

## 文档

| 位置 | 缺口 |
|---|---|
| `README.md` | 未说明五个窗口是**累积**的（读者可能误以为独立分桶、以为数字矛盾）；也未说明计数单位（同会话 read 两次记两次） |
| `README.md` | `stats` 没有示例输出（列表输出有示例） |
| `README.md` | 未提子代理会话可能漏采（0 的另一个来源） |
| `README.md` | 代码结构里 `usage.ts` 一行未提 `readEvents`/`appendEvents`/`statsStart` —— `[有意取舍]` 块内每行都是同类选择性概括 |

## 仓库级

| 问题 | 说明 |
|---|---|
| `MODULE_TYPELESS_PACKAGE_JSON` 警告 | `package.json` 无 `"type": "module"`；仓库既有，非本次引入。测试输出因此不 pristine |
| `loadExtensions` 需要 `cwd` | 用 pi 自己的 loader 验证扩展时 `cwd` 是必填参数（无默认值），漏传会在 pi 内部 `paths.js:51` 抛错。此坑应写回用户级 `AGENTS.md` 的「工具怪癖」段 |
| `files: ["pi"]` | 会把 `*.test.mts` 一起发布出去，属既有形态 |
