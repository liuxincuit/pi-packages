# rules-context

按文件路径注入规则，`@the-forge-flow/pi-rules` 的单文件精简版。

## 做什么

从规则目录加载带 frontmatter 的 `.md` 规则，当 `read` / `edit` / `write` 操作的文件路径命中规则的 `paths` 模式时，把规则正文以 `<system-reminder>` 包裹后**前置**注入该工具的结果。

规则目录（存在才扫描，按顺序遍历并去重）：

```
~/.pi/rules/      ~/.claude/rules/
<cwd>/.pi/rules/  <cwd>/.claude/rules/
```

规则格式：

```markdown
---
description: 可选，仅作说明
paths: "src/**/*.ts, lib/**/*.ts"
---
正文 markdown，命中时注入。
```

`paths` 支持三种写法：逗号分隔字符串、`- item` 列表、`[a, b]` 数组。省略或为空表示对所有文件生效。

glob 支持 `*`（不跨 `/`）、`**`（跨 `/`）、`?`、`{a,b}`。

## 语义

- **无优先级**：所有命中的规则都注入
- **会话内每个规则文件只注入一次**（按 realpath 去重）
- 无 `paths` 的规则对所有文件生效

## 调试

命中时若在 TUI 会话里会弹 `应用规则: <description 或路径>` 通知。规则加载失败会往 stderr 写 `[rules-context] ...`。

## 陷阱

**无热重载。** 规则只在 `session_start` 时扫描一次，改完规则需要重启会话才生效。

**只对 `read` / `edit` / `write` 触发**，其他工具（含 bash）不走这条路径。

**路径在工作目录之外时规则不生效**——`toRelativePosix` 对 cwd 之外的绝对路径返回 `null`，直接跳过。

frontmatter 解析是零依赖的手写实现，格式错误只警告并跳过该文件，不影响其他规则。
