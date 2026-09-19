# tree-summaries

把「总结当前对话 + 回到会话树开头」做成可配置的预设方案：每个方案是方案目录下的一个 `.md` 文件，pi 启动后自动变成 `/tree:<文件名>` 命令。

按下命令后发生三件事：

1. 用方案正文当摘要指令，让当前模型总结当前对话
2. 摘要 entry 落在旧对话**之前**，成为新分支的起点（仍在同一个 session 文件里）
3. 编辑器清空，直接写下一个任务

典型用法：按维度交接同一个任务——需求维度、实现方案维度、代码改动维度各写一个方案文件。

## 配置

### 方案目录

| 目录 | 作用域 |
|---|---|
| `<cwd>/.pi/tree-summaries/` | 项目级，仅项目受信任时扫描 |
| `~/.pi/agent/extensions/tree-summaries/` | 全局 |

同名方案项目级优先。目录不存在就当作没有方案，不报错。

### 方案文件格式

```markdown
---
description: 需求维度交接
argument-hint: [关注点]
mode: append
---
只保留需求本身：原始诉求、约束条件、验收标准、中途变更过的需求点。
```

| frontmatter 字段 | 默认 | 说明 |
|---|---|---|
| `description` | 文件名 | 补全列表里显示的说明 |
| `argument-hint` | 无 | 补全列表里显示在说明后的参数提示 |
| `mode` | `append` | `append` = 正文拼在内置摘要模板之后；`replace` = 正文完全接管摘要 prompt |

正文（frontmatter 之后的内容）为空的文件会被跳过。

### 两种 mode 怎么选

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

- **目标位置**：当前分支的**第一条用户消息**之前。对话从根开始时，摘要 entry 会成为一个新的 root。
- **增量交接**：第二次执行时，第一条用户消息是上一次交接之后的那条，所以只覆盖增量内容，不会摘要套摘要。
- **摘要模型**：当前会话模型，不可另行指定。
- **编辑器**：清空，第一条用户消息的原文不会回填（需要回填请直接用 `/tree`）。
- **同一 session 文件**：旧分支永久保留，用 `/tree` 一步回得去。文件不会因为交接而变小。

## 调试

**单元测试**（零依赖，Node ≥ 22 直接用原生类型剥离跑 TS）：

```bash
node --test pi/extensions/tree-summaries/logic.test.mts
```

覆盖 `logic.ts` 的四个纯函数：方案文件解析、指令拼接、首条用户消息定位、有无可摘要内容判定。

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

**TUI 手动验证剧本**（纯逻辑测不到的部分）：

1. `mkdir -p ~/.pi/agent/extensions/tree-summaries && printf -- '---\ndescription: 测试方案\n---\n保留需求与约束。\n' > ~/.pi/agent/extensions/tree-summaries/req.md`
2. `/reload` → 输入 `/tree:` 应看到 `tree:req`，描述为 `[全局] 测试方案`
3. 聊几轮后执行 `/tree:req` → 状态栏出现「正在按「req」总结当前对话...」，随后聊天区重置，第一条消息是一张 branch summary 卡片
4. 卡片内容应含方案正文要求的结构；在摘要后随便说一句，`/tree` 应看到摘要卡片作为新 root 与旧对话并列
5. 再执行一次 `/tree:req 只保留待办事项` → 只应总结上一次交接之后的内容

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
