# Design

## Context

动机见 proposal.md - Why。本文只记录决定实现方式的现状、约束与实测证据，全部在 pi 1.1.0 上验证。

### skill 的加载与消费链路

```
resource-loader 从多来源加载 skill
   <agentDir>/skills/            scope=user     origin=top-level
   <cwd>/.pi/skills/             scope=project  origin=top-level
   package 声明的 skills          scope=user     origin=package
   .agents/skills/、settings.skills、--skill
        |
        v
Skill { name, description, filePath,
        sourceInfo{source, scope, origin}, disableModelInvocation }
        |
        +---------------------------+
        v                           v
 系统提示 sections.skills      /skill:name 命令
 （只含 disableModelInvocation 为假的）   （由 pi 注册，扩展无法注销）
        |
        v
   模型自动路由；模型 read SKILL.md 才加载正文
```

### 实测确认的三个事实

探针扩展在真实 `pi -p` 会话中运行，结论如下。

**1. `ExtensionCommandContext.getSystemPromptOptions()` 可用，但不是公开类型成员。**

```
命令上下文      typeof ctx.getSystemPromptOptions === "function"   实测返回 27 个 skill
session_start   undefined（ctx 的 19 个自有键里没有它）
before_agent_start  undefined
```

它返回 agent-session 的 `_baseSystemPromptOptions`，其 `skills` 是 `resourceLoader.getSkills().skills` 的原始结果 —— 含 package 来源、`.agents/skills`、以及被作者声明隐藏（`disableModelInvocation`）的那些。该对象在 session 初始化阶段就被填充（扩展注册工具触发 `_setActiveTools` → `_rebuildSystemPrompt`；会话恢复走 `_restoreToolsFromTranscript`），因此**在用户发出第一条消息之前就可用**。

**2. `before_agent_start` 的 `systemPromptOptions.skills` 可写，且真的改变模型所见。**

```
handler 内把 27 个过滤成 26 个（删 xlsx）
   ↓
会话 JSONL 第一条 system 消息的 sections.skills 标签数 = 24
   = 26 - 2 个 disableModelInvocation
   含 xlsx = false，含 grill-me = true
```

**3. 写入不会污染 pi 的基础副本。**

runner 入口每次都重建 options：

```js
async emitBeforeAgentStart(prompt, images, systemPromptOptions) {
    const currentOptions = normalizeBuildSystemPromptOptions(systemPromptOptions);   // 新对象
}
// normalizeBuildSystemPromptOptions 内部
skills: (input.skills ?? []).map((skill) => ({ ...skill }))                          // 新数组 + 元素浅拷贝
```

实测：handler 里删掉 xlsx 之后，再从命令上下文读 `getSystemPromptOptions()` 仍是 27 个、xlsx 仍在。**因此不需要在扩展侧维护快照**，任何时候读都是干净的原始列表。

**4. 命令输出天然不进上下文。**

探针命令执行成功（写入了 out.json），而整个会话文件只有 system / user / assistant 三条 message，没有任何命令残留。

## Goals / Non-Goals

**Goals:**

- 让「模型看得见哪些 skill」成为一个可查询、可即时修改、分作用域生效的运行期状态
- 修改发生在提示构建层，不触碰任何 skill 文件、pi settings 或扩展自带命令注册
- 命令输出与扩展内部状态都不进入模型上下文

**Non-Goals:**

- 不做命令层拦截：被禁用的 skill 仍可由用户 `/skill:name` 显式调用
- 不做内容层拦截：不禁用 `read` 对被禁 skill 文件的读取
- 不改变 skill 的发现与去重规则（重名仍由 pi 保留第一个）
- 不提供让模型自行开关 skill 的工具

## Decisions

### D1：过滤点在 `before_agent_start`，而不是改文件或改配置

在 handler 内重写 `event.systemPromptOptions.skills`。

| 备选方案 | 为什么不用 |
|---|---|
| 改 `SKILL.md` 的 `disable-model-invocation` | 修改用户源文件；作用域无法按项目区分；需要 `/reload` |
| 在 settings 的 `skills` 数组里加 `-path` / `!glob` 排除 | 排除规则只在 settings 声明的路径条目上生效，覆盖不到默认目录与 package 来源；需要 `/reload`；会污染用户 settings |
| 把 skill 目录改名 | 破坏性操作，且同样无法区分作用域 |
| 用 `input` 事件拦 `/skill:name` | 见 D5，方向相反 |

写入的是 pi 每次请求重建的副本（Context 事实 3），因此开关互不干扰，也无需清理。

### D2：列表数据源用命令上下文的 `getSystemPromptOptions()`

| 备选方案 | 为什么不用 |
|---|---|
| 缓存 `before_agent_start` 拿到的 skills | 未发过第一条消息时缓存为空；且平白引入一份会过期的状态 |
| 扩展自行调用 `loadSkills()` 扫描 | `includeDefaults` 只覆盖 `<agentDir>/skills` 与 `<cwd>/.pi/skills`，漏掉 package 与 `.agents/skills` 来源 |
| 解析 `ctx.getSystemPrompt()` 的 `<available_skills>` XML | 公开 API，但漏掉作者声明隐藏的 skill，无法区分两类不可见原因 |

采用 `getSystemPromptOptions()` 作为主路径，配 `??` 降级到解析 `getSystemPrompt()`，再用 `loadSkills()` 补 `disableModelInvocation`。

### D3：三层三态覆盖，而不是三个禁用列表

```
优先级                存储                                     取值
会话层（最高）   进程内存（按 sessionId 隔离）        禁用 / 启用 / 未提及
项目层           <cwd>/.pi/extensions/pi-skills/config.json
全局层（最低）    <agentDir>/extensions/pi-skills/config.json
                     |
                     v
        对每个 skill 取优先级最高的「显式设定」
```

必须三态：「全局禁用 xlsx，本项目启用 xlsx」在双集合模型下无法表达。

配置格式：

```json
{ "version": 1, "skills": { "xlsx": "disabled", "git-commit": "enabled" } }
```

`agentDir` 取 `process.env.PI_CODING_AGENT_DIR ?? ~/.pi/agent`（`ExtensionContext` 不提供该路径）。

### D4：会话层状态纯内存，不随分支持久化

用户决策。用 `Map<sessionId, Map<skillName, "disabled" | "enabled">>` 而非模块级单例：扩展 factory 在每个会话各执行一次，但模块只 import 一次，模块级变量会在父会话与同 cwd 的子代理之间共享。

代价：`/tree` 切到旧分支时，禁用状态停留在「当前」而非「当时」。这是有意接受的，换来的是零 session entry 污染。

### D5：保留 `/skill:name` 显式调用

「禁用」的语义收缩为**只影响模型自动路由**。用户手打 `/skill:name` 是有意行为，不应被工具拦下。pi 也没有注销已注册命令的 API，命令菜单里仍会列出被禁用的 skill —— 这是已知且接受的瑕疵。

### D6：输出走 `ctx.ui.notify`，绝不走 `sendMessage` / `appendEntry`

配合 spec 的「清单输出不进入模型上下文」。这是实现期的硬约束，需要在代码注释中写明原因，避免后续维护者顺手改成 `sendMessage`。

### D7：表格按可见宽度对齐

skill 描述以中文为主，用 `String.length` 补空格会错位，改用 pi-tui 的 `visibleWidth`。

## Risks / Trade-offs

- [`getSystemPromptOptions()` 未在 `ExtensionContext` 公开类型中声明，pi 升级可能移除] → 用 `(ctx as any)` 调用并配 `??` 降级链（D2）；tasks 的第一步就是回归验证该字段仍在。
- [开关变更会改写系统提示的 skills 段，可能影响 provider 的提示缓存] → 可接受：pi 以 section diff 的形式下发变化，本次改动只涉及 skills 段；不做额外缓存优化。
- [占用模型上下文之外的状态，进程重启即失效（会话层）] → 这是会话层的定义，不是缺陷；需要长期生效时用 `--project` / `--global`。
- [项目配置在未受信任的项目里被读取，可能被仓库用来影响模型所见] → 读项目配置前检查 `ctx.isProjectTrusted()`，与 pi 自身对项目级资源的处理一致。
- [并发写配置文件] → 写入采用「读-改-写整文件」并置于 pi 的 `withFileMutationQueue()` 内，避免与同进程其他写者交错。

## Migration Plan

1. 本仓库增加 `package.json`，声明 `pi.extensions: ["./pi/extensions"]`
2. 把 `D:/code/pi-skills` 加入 `~/.pi/agent/settings.json` 的 `packages`（独立于代码实现，动手前单独确认）
3. `/reload` 或重启 pi 后 `/skills` 可用

回滚：从 `packages` 移除该条目并重启；两个 `config.json` 可直接删除，删除后所有 skill 恢复默认可见。
