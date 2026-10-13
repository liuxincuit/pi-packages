# Design

## Context

现有扩展 `skill-manager` 的形态决定了新能力的边界：

- 三个纯逻辑模块（`skills.ts`、`scope.ts`、`render.ts`、`complete.ts`）不 import pi 运行时，可以直接 `node --test` 跑。
- 所有输出只走 `ctx.ui.notify`，绝不进模型上下文。
- 除作用域配置外不往磁盘写任何东西；配置损坏时按「未提及」降级。

新能力要引入的第一件事是**运行时状态**（本机调用日志），这是现有代码里没有的先例，也是本次设计里大部分取舍的来源。

### 数据从哪来：两条路的实测对比

`pi` 的会话记录（`~/.pi/agent/sessions/**/*.jsonl`）里确实能找到全部历史调用。实测扫描 473 个文件 / 117.7 MB：

```
   readline 逐行 + 预筛        790 ms
   整文件读入 + Buffer 标记扫描  210 ms     <- 快 3.7 倍，结果一致
```

但把它当真相源有三处硬伤，都实测到了：

1. **fork / 分支会话会复制历史条目**，消息 id 保持不变。本机 37403 个条目里 2445 个 id 跨文件重复，落到 skill 读取上是 354 条原始记录去重后只有 271 条，**膨胀 1.31 倍且不均匀**（`supermap-wiki` 虚高 2.33 倍，`git-commit` 只有 1.06 倍）。
2. **成本随历史体积线性增长**（1.5 ms/MB + 0.06 ms/文件），且无法假定使用强度——按体积外推，个人机器一年后约 2 秒，批量/CI 机器上 30 GB 要 48 秒。
3. **依赖 pi 私有的会话文件格式**。

事件钩子路线没有这三处问题：零扫描、不膨胀、依赖的是公开扩展 API。

## Goals / Non-Goals

**Goals:**

- 高置信度地记录「哪些 skill 真的被加载过」，并让统计在极端使用强度下仍然可用。
- 采集对会话行为零影响——不改变任何工具调用的成败，不阻断、不改动用户输入。
- 在无法避免的数据缺口上，让输出**说清楚自己覆盖了什么**，而不是假装完整。

**Non-Goals:**

- 不追求统计的完整性保证。这是实时记录的固有代价，接受并显式标注，不用扫描去补。
- 不做跨机器同步、不做按项目/模型/来源层级的拆分（字段留了口子，见 D4）。
- 不统计 `read` 之外的加载方式。

## Decisions

### D1 真相源：实时事件记录，不回填

**选择**：扩展在会话内观察调用事件，写自己的日志。不扫描既有会话记录。

**为什么**：这是唯一成本与使用强度解耦的方案，也避开了 fork 造成的计数膨胀。

**代价（明确接受）**：日志是唯一副本，没有重建路径；判定规则一旦落盘就无法重算历史；0 的语义是「自安装起没记录过」，不等于「从未使用」。规格里用「统计起点可辨识」把这条语义摆到产品表面上。

**考虑过的替代**：扫描会话记录（数据可重建、口径可重算，但有上面三处硬伤）；扫描 + 增量缓存（稳态 <50ms，但要维护水位、失效与半行 JSON 的续读边界）；实时记录 + 一次性回填（吃掉两套机制的复杂度，只换来安装当天不是一片零）。

### D2 只挂通知型事件，不挂门禁型事件

pi 的事件派发有三个函数，异常隔离级别不同：

| 派发函数 | result 语义 | 异常处理 | 涉及事件 |
|---|---|---|---|
| `emitToolCall` | 可 block、可改参数 | **没有 try/catch**，异常抛出并阻断工具 | `tool_call` |
| `emitInput` | 可 handled、可 transform | try/catch + `emitError`，继续下一个 | `input` |
| `emit`（通用） | 仅少数 `session_before_*` 可 cancel | try/catch + `emitError`，继续下一个 | `tool_execution_*`、`message_*` |

`tool_call` 是**唯一没有异常隔离**的派发点，两个方向都会互相伤害：

- 我们抛异常 → 用户的工具调用失败（错误文案是 `Extension failed, blocking execution`）。日志写盘在 Windows 上会因文件被占用、杀毒扫描、磁盘满而失败，这条路径是现实存在的。
- 别的插件抛异常 → 链断掉，我们的 handler 根本不被调用，**静默漏记**。数据的完整性取决于别人的插件写得好不好。

**选择**：

```
   read 通道    tool_execution_start + tool_execution_end   成对使用，见 D2b
   /skill: 通道  message_start                              通知型，不参与可替换消息的链
```

（`message_end` 有替换消息的 result 语义，不用。）

### D2b read 通道必须成对使用两个事件

`ToolExecutionEndEvent` 带 `isError` 但**没有 `args`**，拿不到路径；`ToolExecutionStartEvent` 有 `args` 但发出时工具还没跑。所以要用 `toolCallId` 把两者配对：start 记下候选路径，end 确认后才提交。

**为什么不能只挂 start**（这里的判断被我推翻过一次，记录在此）：`tool_execution_start` 是在 `runToolCall` **之前**发出的：

```js
// executeToolCallsSequential / executeToolCallsParallel
for (const toolCall of toolCalls) {
    await emit({ type: "tool_execution_start", toolCallId, toolName, args });
    ... runToolCall(...)        // 阻止发生在这里面（prepareToolCall）
}
```

而「被阻止」发生在 `runToolCall` → `prepareToolCall` 里，所以**被阻止的调用也会发出 start**。此外 `failToolCallsFromTruncatedMessage` 也会为每个未执行的调用发 start。只挂 start 会把这些一起记进去。

**提交判据**：`durationMs !== undefined && isError === false`。

```
   executePreparedToolCall   成功路径、catch 路径      都返回 durationMs
   prepareToolCall immediate block / not found / aborted  -> 不经过它，无 durationMs
   failToolCallsFromTruncatedMessage                      -> 无 durationMs
```

`durationMs === undefined` 精确对应「工具没真正执行」。

**实测分布**（473 个会话，read SKILL.md 的调用全部能配对到结果）：

```
   成功 327 / 失败 5   失败率 1.5%
   失败明细: writing-skills 1、test-driven-development 1、grill-me 1、systematic-debugging 2
   被阻止 0 次、因输出截断未执行 0 次
   没有「只有失败、从无成功」的 skill
```

失败全是 `ENOENT`，两类成因：MSYS 把 `/c/Users/...` 拼成 `D:\c\Users\...`；以及模型按系统提示里的旧 `location` 去读一个已经不在的文件。

**为什么值得为 1.5% 付这个成本**：它防住的正是「skill 刚被删、系统提示还留着旧 location、模型反复按旧路径尝试」那段污染。本机数据里已有影子（`systematic-debugging`、`grill-me` 都留下过失效路径的尝试），只是同期也有成功记录才没被淹。用户删掉一个 skill 又没 reload 会话时，表上就会出现一个「用过」但其实从未加载成功的 skill。

代价是一个按 `toolCallId` 的 pending 表，加一个 `agent_end` 清理点（防止未配对的条目在会话内累积）。

### D3 两条通道都采集

实测的两条通道比例是 **271 : 45 ≈ 86% : 14%**，而且分布极不均匀：

```
   retrospective   显式 17 / 合计 23 = 74%
   find-skills     显式  3 / 合计  4 = 75%
   grill-me        显式  5 / 合计  8 = 62%
```

只采 `read` 会让 `retrospective` 从第 2 名掉到第 11 名，还会漏掉两个只被显式调用过的 skill。所以规格把「两条通道」写成同一个 requirement 下的两组 scenario。

两侧重叠很小——显式调用后 10 分钟内又 `read` 同一个 skill 的只有 47 次里的 1 次（2%），所以两条通道各自计数即可，不需要去重规则。

`/skill:` 的解析用 pi 公开导出的 `parseSkillBlock`，实测对历史里 47 条真实的展开消息 **47/47 解析成功**。不使用自己写的正则。

### D4 日志以 path 为主键，name 是派生数据

```jsonl
{"ts":"2026-10-13T03:17:29.722Z","via":"read","path":"D:/code/skills/skills/git-commit/SKILL.md","session":"01a12f73-…","cwd":"D:/code/pi-skills"}
{"ts":"2026-10-13T04:02:11.101Z","via":"explicit","path":"…/retrospective/SKILL.md","session":"01a13340-…","cwd":"D:/code/pi-skills"}
```

**为什么 name 不进日志**：

- read 通道从 `tool_execution_start` 只拿得到 `args.path`，要映射成 name 得查已加载清单，那是重活，不在热路径上做。
- 显式通道虽然能从 `parseSkillBlock` 拿到 `name`，但同一块里的 `location` 就是同一个 SKILL.md 路径，两条通道天然共享主键。
- 附带好处：skill 改名后历史自动跟着新名字显示，不需要数据迁移。

`via` 和 `cwd` 都记，遵循一条原则：**记录时没写进去的维度就是永久失去的**。这两个字段各占几十字节，换的是「将来能按通道或项目拆」的自由度。展示层按 name 聚合，所以存储层的区分能力不会变成界面噪音。

### D5 路径归一化是必须的，不是洁癖

实测 **354 次读取里有 15 次用的是相对路径**（`skills/foo/SKILL.md`、`./.claude/skills/archon/SKILL.md`），而且正好让 10 个 skill 同时以两种形态出现：

```
   supermap-wiki、supermap-youtrack、supermap-jira、supermap-cve-analysis、
   supermap-cdci-analysis、supermap-docs-writer、supermap-search、
   supermap-sonar-error-analysis、supermap-scrum、skill
```

不归一化的话这 10 个 skill 会在表里各裂成两行。

**规则：**

```
   1.  \  ->  /                     统一分隔符
   2.  相对 -> 绝对（用 ctx.cwd）     写入时完成
   3.  不碰大小写                    Linux 上大小写有语义；实测 354 次无变体
```

残余的写法差异由展示层兜底：存储按归一化 path 保留区分能力，展示按 name 聚合。

顺带确认：`endsWith("/SKILL.md")` 是安全的（354/354 全为这个写法），也没有裸 `SKILL.md` 的相对写法出现。

### D6 同步追加写，不做缓冲

```
   appendFileSync 单次 123 us（含 open/write/close）
   实测频率 354 次 / 5 个月 ≈ 2.4 次/天
```

频率低到这个量级，「可靠性 vs 延迟」是个假问题。直接同步写：崩溃不丢、不需要 flush 时机、不需要内存缓冲。

**handler 的四条纪律**（规格里对应「采集不改变会话行为」）：

```
   不 await        不把 I/O 延迟和失败传染给事件派发链
   不外抛          整个 body 包 try/catch，catch 里什么都不做
   不改 event      事件对象对其他插件共享
   早返回          先判 toolName / role，再取字段
```

### D7 表格以日志为主轴

`/skills` 的清单是「此时此刻这个会话加载了什么」，日志是「这台机器所有项目、从安装起」。两者不是一回事——实测幽灵（有记录但当前未加载）覆盖了约 **28% 的调用量**。以当前清单为主轴会让表随项目漂移，并把近三成的用量藏起来。

**选择**：以日志为主轴，分三段（当前加载 / 当前未加载 / 当前加载但无记录）。

第二段的标题用「当前未加载」而不用「已不再加载」——项目级 skill 在别的项目里本来就不加载，后者会让用户误判成「被卸载了」。

窗口按滚动小时算（72 / 168 / 720 / 2160 / 4320），标签仍写 3天/7天/1月/3月/半年：无歧义、不依赖时区、直接和 ISO UTC 时间戳做差。

「最后使用」列不能省。实测它提供的信息窗口计数给不出：

```
   supermap-cve-analysis   半年 23 次   最后使用 25 天前    <- 看着活跃，实际停了
   supermap-server-…       半年 10 次   最后使用 127 天前   <- 全是半年前的一次性使用
```

### D8 不做心跳，不做覆盖率检测

覆盖率检测（列出会话目录里的会话 id，和日志里的会话 id 对比，暴露漏采）实测只要约 30 ms——文件名里就带 session id 和时间戳（**472/473 个文件验证一致**），不需要解析任何内容。它能把「静默漏采」变成可见警告。

**但仍然不做**，理由是它是独立的一层概念（心跳记录 + 会话清单 + 覆盖率提示），而漏采在这套设计里已经被接受了。保持首版最小；真需要时再按 `via: "session"` 的心跳扩展，日志格式已经留了位置。

## Risks / Trade-offs

**三个只能在实现后验证的假设**（都会在首次运行暴露，但需要主动去验，不会自己冒出来）：

| 假设 | 若为假的后果 | 验证方式 / 降级 |
|---|---|---|
| `message_start` 在 `/skill:` 场景下带的是展开后的文本 | 显式通道整条失效 | 首次跑 `/skill:xxx` 后看日志有没有新记录；无则改挂 `input`，代价是要额外校验 skill 名存在性 |
| `/tree` 切分支或恢复旧会话不重放 `message_start` | 历史条目被重复计数，实时方案「不膨胀」的优势失效 | 切一次分支后比对日志条数 |
| 子会话里 `ctx.cwd` / `getSessionId()` 返回子会话自己的值 | 子代理的调用被记到父会话名下 | 跑一个子代理后检查日志中的 session 与 cwd |

**静默漏采** → 子代理会话默认继承扩展，但 `excludedExtensionPackages` 可以把本包排除在子会话之外，实测子代理占全部调用的 **13%**（`supermap-cve-analysis` 有 67% 来自子代理）。这类漏采没有任何痕迹。**接受**，靠「统计起点在输出中可辨识」承担诚实义务，不靠覆盖率检测。

**不可重算** → 判定规则或统计口径一旦落盘就无法回溯修正。**缓解**：日志只记原始事件（时间、通道、路径、会话、cwd），不做任何预聚合，把可重算的余地留在日志结构里；真要改口径，只能从改动生效起算。

**照表的 0 会驱动删除动作** → 因为不回填，「自安装以来 0 次」和「从未使用」不是一回事，而这个功能的用途正是「看哪些没用过 → 删掉」。假阴性比假阳性贵得多。**缓解**：统计起点标注 + 「已加载但无记录」单独成段而非混在次数为 0 的行里。

**日志是私有的运行时状态** → 现有扩展除配置外不写盘，这是一个新的失败面（文件损坏、被清、跨机器丢失）。**缓解**：日志放 `<agentDir>/extensions/pi-skills/`（与 `config.json` 同目录），append-only，损坏时逐行跳过；任何读取失败都降级为「全部无记录」，不影响其余命令。

**展示层的「当前已加载」基准本身会飘** → 探索期实测到：同一会话持久化的提示里是 38 个 skill，而实际可见的是 41 个（差 3 个，未查明根因）。**缓解**：沿用现有 `readSkills(ctx)`（优先取 `ctx.getSystemPromptOptions()`），它拿的就是模型实际所见的那一份；不自行解析会话文件。

## Migration Plan

无数据迁移。新能力是纯增量：

- 首版发布后统计从零开始，表头明示起点。
- 回滚：删除 `<agentDir>/extensions/pi-skills/usage.jsonl` 即可清除全部统计；卸载包则采集自动停止。两者都不影响 `config.json` 里的作用域设定。
- `/skills`、`/skills disable`、`/skills enable` 的现有行为与输出不受影响。

## Open Questions

- **幽灵行是否要展开显示**：规格已定为分三段呈现，但第二段是否折叠、阈值取多少属于排版细节，可以留到实现时按真实数据量调。
