# tree-summaries

把「干活（可选）+ 回到会话树开头 + 留下上下文」做成可配置的预设方案：每个方案是方案目录下的一个 `.md` 文件，pi 启动后自动变成 `/tree:<文件名>` 命令。

方案有两种，由 frontmatter 的 `kind` 决定：

| `kind` | 执行方式 |
|---|---|
| `summary`（默认） | 方案正文当自定义指令交给内置摘要器，摘要 entry 落在旧对话**之前**，成为新分支的起点 |
| `agent` | 方案正文当任务发给当前 agent（全套工具，能写文件、能引用 skill）；干完后切回**分支最前端**，把产出文件的路径填进编辑器 |

全程同一个 session 文件，旧分支用 `/tree` 一步回得去。

典型用法：`summary` 按维度交接同一个任务（需求 / 实现方案 / 代码改动）；`agent` 写交接文档供下一个 agent 接手——内置的 `handoff.md` 就是这个。

## 配置

### 方案目录

| 目录 | 作用域 |
|---|---|
| `<cwd>/.pi/tree-summaries/` | 项目级，仅项目受信任时扫描 |
| `~/.pi/agent/extensions/tree-summaries/` | 全局 |
| `<扩展目录>/builtin/` | 内置，随扩展走，开箱即用（`handoff.md` 就在这里） |

同名方案的优先级：项目级 > 全局 > 内置。目录不存在就当作没有方案，不报错。

### 方案文件格式

```markdown
---
description: 需求维度交接
argument-hint: [关注点]
kind: summary
mode: append
---
只保留需求本身：原始诉求、约束条件、验收标准、中途变更过的需求点。
```

| frontmatter 字段 | 默认 | 说明 |
|---|---|---|
| `description` | 文件名 | 补全列表里显示的说明 |
| `argument-hint` | 无 | 补全列表里显示在说明后的参数提示 |
| `kind` | `summary` | `summary` = 内置摘要器总结；`agent` = 正文交给当前 agent 执行 |
| `mode` | `append` | 仅 `summary` 型有效，见下 |
| `output-dir` | 无 | 仅 `agent` 型有效，产物目录（相对 cwd），见下 |

正文（frontmatter 之后的内容）为空的文件会被跳过。

### agent 型：让 agent 干完活再切

正文是给当前 agent 的任务指令。它有全套工具——能读会话、写文件、看 skill 清单——所以能做摘要器做不到的事：产出一份落盘的交接文档，用路径引用 specs / issue，列出建议接手者调用的 skill。

```markdown
---
description: 写交接文档，然后回到对话开头继续
kind: agent
output-dir: .pi/handoffs
---
总结当前对话，写一份交接文档，以便新的 AI Agent 接手继续工作……
```

执行链路：

1. 扫一遍 `output-dir`（相对 cwd），记下每个文件的修改时间
2. 正文发给当前 agent，等它彻底跑完（含工具调用与多轮）
3. 再扫一遍目录，与开工前的快照对比，找出新增或被修改的文件
4. `navigateTree` 切回**分支最前端**，**不生成摘要**——交接文档就是上下文
5. 把产出文件的路径**填进编辑器**（不直接发出去）：「继续之前的工作，先读 `.pi/handoffs/HANDOFF-xxx.md`。」——按不按回车、要不要先改两句，都由你决定

**产出文件由方案正文自己约定。** 扩展只按 `output-dir` 扫目录找出「这次新写或改过的文件」；写什么文件、叫什么名字、内容多长，全看正文怎么写。配了 `output-dir` 却没写出任何文件时会提示并**不切分支**——交接没成立，切了也没人接手。

不配 `output-dir` 时只干活 + 切分支。注意这时新分支是真的空白：没有摘要、没有衔接提示，接手者拿不到任何线索。

**为什么切最前端而不是第一条用户消息之前**：summary 型要落在第一条用户消息之前，好让新摘要接在链上旧摘要之后，形成增量摘要链；agent 型不生成摘要，链上那些旧摘要属于上一次交接，留着只会让接手者误以为那是本次交接的内容。

agent 干活期间按 ESC 会取消切分支，不会把用户突然甩到另一个分支。

### summary 型：两种 mode 怎么选

**`append`（默认）** — 正文是"额外关注点"，内置模板继续提供结构（Goal / Progress / Key Decisions / Next Steps / Critical Context）。一句话就能定义一个方案，输出结构稳定。

**`replace`** — 正文完全替换内置模板。需要自己写全输出结构，否则摘要质量随模型波动。适合要精确控制交接文档格式的场合。

两种模式都会自动在摘要尾部追加 `<read-files>` / `<modified-files>` 文件清单，正文里不用写。

### 用法

```
/tree:req
/tree:req 重点总结多线程并发访问问题
```

命令后的文字会以 `## 补充要求` 一节拼在正文后面，只影响这一次执行。

### 完整示例：replace 模式

（方案文件写法与 summary 型一致，只是 `mode` 换成 `replace`。）

```markdown
---
description: 实现方案交接
mode: replace
---
你正在写一份实现交接文档，读者是失去本次对话全部记忆的自己。

按以下结构输出：

## 目标
## 已定方案
（含否决过的替代方案与原因）
## 数据结构与接口
（确切的类型、函数签名、路径）
## 已知风险
## 下一步

要求：写结论与事实，保留确切的路径、命令、错误信息。不要列文件清单。
```

## 行为

- **切割点**：summary 型落在当前分支**第一条用户消息之前**（新摘要接在链上旧摘要之后）；agent 型落在**分支最前端**（链上所有旧摘要都留在旧分支，新分支只剩配置 entry）。
- **增量交接（summary 型）**：第二次执行时，第一条用户消息是上一次交接之后的那条，所以只覆盖增量内容，不会摘要套摘要。
- **摘要模型**：当前会话模型，不可另行指定（仅 summary 型）。
- **编辑器**：summary 型清空，第一条用户消息的原文不会回填（需要回填请直接用 `/tree`）；agent 型在有产出文件时填入衔接提示，等你回车。
- **同一 session 文件**：旧分支永久保留，用 `/tree` 一步回得去。文件不会因为交接而变小。
- **agent 型的新分支不继承任何摘要**：上下文全靠落盘的文件，所以方案正文必须自己管好产出——否则接手者面对的是一片空白。

## 调试

**单元测试**（零依赖，Node ≥ 22 直接用原生类型剥离跑 TS）：

```bash
node --test pi/extensions/tree-summaries/logic.test.mts
```

覆盖 `logic.ts` 的纯函数：方案文件解析（含 `kind` / `output-dir`）、指令拼接、首条用户消息定位、有无可交接内容判定、中断判定、目录快照与产物对比。

**加载验证**（零安装：直接引用 pi 自带的 esbuild，通用流程见 `skills/pi-extension-dev/`）。在**仓库根目录**执行：

```bash
PI_ROOT="$(dirname "$(dirname "$(dirname "$(readlink -f "$(command -v pi)")")")")"
mkdir -p .pi/T/ext-verify/node_modules
ln -sfn "$PI_ROOT/node_modules/typebox" .pi/T/ext-verify/node_modules/typebox
printf 'import ext from "%s/pi/extensions/tree-summaries/index.ts";\nconsole.log(typeof ext);\n' "$PWD" > .pi/T/ext-verify/verify.ts
node "$PI_ROOT/node_modules/esbuild/bin/esbuild" .pi/T/ext-verify/verify.ts \
  --bundle --platform=node --format=esm \
  --external:@earendil-works/* --external:typebox --outfile=.pi/T/ext-verify/out.mjs
node .pi/T/ext-verify/out.mjs   # 应输出 function
```

**agent 型端到端 mock**（用假 pi / ctx 驱动 handler，走完整条「发任务 → 扫产物 → 切分支 → 注入衔接」链路）：

```bash
PI_ROOT="$(dirname "$(dirname "$(dirname "$(readlink -f "$(command -v pi)")")")")"
node "$PI_ROOT/node_modules/esbuild/bin/esbuild" pi/extensions/tree-summaries/index.ts \
  --bundle --platform=node --format=esm \
  --external:@earendil-works/* --external:typebox --outfile=.pi/T/ext-verify/ts-agent.mjs
node .pi/T/ext-verify/agent-e2e.mjs
```

**内置方案定位检查**（用 jiti 按 pi 的方式加载真实 `index.ts`，在隔离的 HOME + cwd 下看 `/tree:handoff` 是否来自内置目录）：

```bash
PI_ROOT="$(dirname "$(dirname "$(dirname "$(readlink -f "$(command -v pi)")")")")"
PI_ROOT="$PI_ROOT" node .pi/T/ext-verify/builtin-check.cjs              # 隔离环境
PI_ROOT="$PI_ROOT" node .pi/T/ext-verify/builtin-check.cjs --real-home  # 真实 HOME
```

**TUI 手动验证剧本**（纯逻辑测不到的部分）：

summary 型：

1. `mkdir -p ~/.pi/agent/extensions/tree-summaries && printf -- '---\ndescription: 测试方案\n---\n保留需求与约束。\n' > ~/.pi/agent/extensions/tree-summaries/req.md`
2. `/reload` → 输入 `/tree:` 应看到 `tree:req`，描述为 `[全局] 测试方案`
3. 聊几轮后执行 `/tree:req` → 状态栏出现「正在按「req」总结当前对话...」，随后聊天区重置，第一条消息是一张 branch summary 卡片
4. 卡片内容应含方案正文要求的结构；在摘要后随便说一句，`/tree` 应看到摘要卡片作为新 root 与旧对话并列
5. 再执行一次 `/tree:req 只保留待办事项` → 只应总结上一次交接之后的内容

agent 型：

1. 建一个临时方案（避免动到真实 handoff）：`printf -- '---\ndescription: 测试交接\nkind: agent\noutput-dir: .pi/handoffs\n---\n把当前对话要点写进 `.pi/handoffs/HANDOFF-测试.md`，三行以内。\n' > ~/.pi/agent/extensions/tree-summaries/xtest.md`
2. `/reload` → 聊几轮后执行 `/tree:xtest`
3. agent 应写出 `.pi/handoffs/HANDOFF-测试.md`，随后聊天区重置（回到分支最前端，**看不到**之前的摘要卡片）
4. 编辑器里应出现「继续之前的工作，先读 .pi/handoffs/HANDOFF-测试.md。」，且**不会自动发出去**；回车后 agent 应去读这份文档
5. `/tree` 应看到旧对话与它顶部的旧摘要都还在旧分支上（agent 型不生成新摘要）
6. 再跑一次、在 agent 干活时按 ESC → 应提示「已中断，未切换分支」，当前分支不变
7. 把方案的 `output-dir` 改到一个空目录再跑 → 应提示找不到文件且不切分支

## 陷阱

| 陷阱 | 说明 |
|---|---|
| 改了正文没生效？ | 正文是 handler 现读的，立刻生效。**增删文件**才需要 `/reload` |
| 文件名含空格 | 会被跳过——pi 按第一个空格切分命令名，`/tree:my plan` 解析不出 `tree:my plan` |
| 命令没出现 | 检查文件是不是 `.md`、正文是否为空、文件名是否含空格、项目是否受信任 |
| `append` 模式下正文写得像完整模板 | 会被当成"额外关注点"拼在内置模板后面，重复要求输出结构反而干扰模型 |
| `replace` 模式下正文只写一句关注点 | 内置模板被完全替换，模型没有结构要求，输出会飘 |
| 只有一条用户消息 | 会被拦下提示"没有可总结的内容"——此时摘要范围为空，pi 只会静默重置 leaf |
| 摘要过程无法中断 | `abortBranchSummary` 只在 AgentSession 上，命令上下文没有；中断入口只在 `/tree` 的流程里绑定 |
| 子代理会话 | 会照常注册命令（无副作用），但子代理不执行 slash 命令 |
| 消息队列 | handler 先 `waitForIdle()`，正在流式输出时执行命令会等本轮结束，不会抛错 |
| agent 型没写出文件 | 配了 `output-dir` 却没产物时会提示并保留当前分支，不会切走 |
| agent 型切到完全空白 | 新分支不继承链上任何摘要（旧摘要属于上一次交接），接手者的线索只有产出文件 + 编辑器里的那行路径；方案正文没约定产出就等于啥都没留 |
| 改了内置方案不生效 | 看看全局目录里是不是有同名文件（会盖住内置）；内置方案的描述标记是 `[内置]` |
| agent 型交接过程留在旧分支 | agent 干活的几轮对话属于旧分支，切走后不在新分支里——这是有意为之，旧分支用 `/tree` 回看 |
| `output-dir` 会进 `git status` | 选一个已被忽略的目录（如 `.pi/`），或在 `.gitignore` 里排除 |
| 交接文档被误当普通文件提交 | agent 只按方案正文的约定写文件，不负责改 `.gitignore`；必要时在方案正文里加一句要求 |
