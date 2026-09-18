# ask-user-question

让模型把选择题交给用户，而不是自己猜。

## 做什么

注册 `ask_user_question` 工具，模型传入一组问题（每题带选项），用户在 TUI 里作答，答案以结构化 JSON 返回。

- 每题渲染选项列表，末尾附 `Type something.` 行用于自由输入（`allowOther: false` 可关闭）
- 多问题时提供 tab 切换与 Submit 复核页
- 通过 `promptSnippet` / `promptGuidelines` 注入系统提示，引导模型只在"答案会改变行为"时才发问，且尽量合并成一次调用
- `executionMode: "sequential"`：等待 UI 时不允许其他工具调用并发

交互骨架取自 pi 示例 `examples/extensions/questionnaire.ts`。

## 配置

无。参数完全由模型在调用时给出。

## 调试

在 TUI 会话里让模型调用一次即可。观察点：

- 单问题：选项 + `Type something.`，回车提交
- 多问题：左右方向键切 tab，最后一页 Submit 复核
- 取消（Esc）返回 `cancelled: true`，不写答案

## 陷阱

**子代理会话里不可用。** 子代理用 `bindExtensions({})` 绑定，pi runner 走 `setUIContext(uiContext, mode = "print")`，所以子会话 `ctx.mode` 恒为 `print`、`ctx.ui` 是 `noOpUIContext`。不拦的话 `ctx.ui.custom()` 返回 `undefined`，读 `result.cancelled` 直接抛 TypeError。本扩展在 `ctx.mode !== "tui"` 时返回错误文本，提示子代理改走核心协议 `ask_parent`。

本工具默认不在子代理的工具白名单里，除非某个 agent frontmatter 显式列出。

**状态必须封在 `execute` 闭包内。** 本仓库的模块由 loader 按路径缓存，父会话与所有同 cwd 的子会话共享同一个模块实例，模块级可变状态会被并发子会话互相踩。

**问题用数组下标定位，不用 id。** 模型给出重复 id 是一类白送的 bug，下标让答案与问题天然对齐。

**参数校验**：某题既无选项又 `allowOther: false` 时无法作答，工具直接返回错误文本而不是渲染空界面。
