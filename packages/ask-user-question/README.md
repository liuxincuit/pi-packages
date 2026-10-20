# ask-user-question

让模型把选择题交给用户，而不是自己猜。

## 做什么

注册 `ask_user_question` 工具，模型传入一组问题（每题带选项），用户在 TUI 里作答，答案以结构化 JSON 返回。

- 每题渲染选项列表，末尾附 `Type something.` 行用于自由输入（`allowOther: false` 可关闭）
- 选项上按 `n` 可以给它挂一条附注，选中该选项时附注随答案一起返回，显示成 `Q1: 2. 方案B — note: 但要先改 X`
- 多问题时提供 tab 切换与 Submit 复核页
- 通过 `promptSnippet` / `promptGuidelines` 注入系统提示，引导模型只在"答案会改变行为"时才发问，且尽量合并成一次调用
- `executionMode: "sequential"`：等待 UI 时不允许其他工具调用并发
- **用户离屏时弹窗提醒**：提问后 10 秒内用户一次按键都没有，就弹一个置顶 MessageBox 把人叫回来（仅 Windows）。用户在场（有按键）或已经答完/取消时不弹

交互骨架取自 pi 示例 `examples/extensions/questionnaire.ts`。

## 配置

无。参数完全由模型在调用时给出。弹窗延时是源码里的 `NOTIFY_DELAY_MS`（默认 10000ms）。

## 调试

在 TUI 会话里让模型调用一次即可。观察点：

- 单问题：选项 + `Type something.`，回车提交
- 多问题：左右方向键切 tab，最后一页 Submit 复核
- 取消（Esc）返回 `cancelled: true`，不写答案

note（同样只能手动验证）：

1. 让模型出一道多选题
2. 光标停在第 2 个选项，按 `n` → 出现 `Note for 2. xxx:` 输入框
3. 输入一句，回车保存 → 选项下方出现 `note: ...`，标签右侧多一个 `✎`
4. 回车选中该选项 → 提交后答案里带 `— note: ...`
5. 重来一次，写完 note 按 Esc → 不保存
6. 已有 note 时再按 `n`，清空内容后回车 → note 被删掉
7. 多问题时按 Tab 仍然切题，不会进 note 输入框

弹窗提醒（只能靠 TUI 手动剧本验证，且仅 Windows）：

1. 让模型调用 `ask_user_question`
2. 界面出现后什么都不按，等 10 秒 → 应弹出置顶窗"pi 正在向你提问"
3. 重来一次，在 10 秒内随便敲一个键 → 不应弹窗
4. 重来一次，10 秒内按 Esc（或直接答完）→ 不应弹窗

## 陷阱

**子代理会话里不可用。** 子代理用 `bindExtensions({})` 绑定，pi runner 走 `setUIContext(uiContext, mode = "print")`，所以子会话 `ctx.mode` 恒为 `print`、`ctx.ui` 是 `noOpUIContext`。不拦的话 `ctx.ui.custom()` 返回 `undefined`，读 `result.cancelled` 直接抛 TypeError。本扩展在 `ctx.mode !== "tui"` 时返回错误文本，提示子代理改走核心协议 `ask_parent`。

本工具默认不在子代理的工具白名单里，除非某个 agent frontmatter 显式列出。

**状态必须封在 `execute` 闭包内。** 本仓库的模块由 loader 按路径缓存，父会话与所有同 cwd 的子会话共享同一个模块实例，模块级可变状态会被并发子会话互相踩。

**问题用数组下标定位，不用 id。** 模型给出重复 id 是一类白送的 bug，下标让答案与问题天然对齐。

**参数校验**：某题既无选项又 `allowOther: false` 时无法作答，工具直接返回错误文本而不是渲染空界面。

**note 用 `n`，不占 Tab。** 多问题时 Tab 已经是“切到下一个问题”。单问题的 Tab 本来空着，但为此让键位按题目数量分叉（单问题 Tab、多问题 n）比统一用 `n` 更难记。

**Type something. 那行不给挂 note。** 它本身就是自由输入，光标停在那行时按 `n` 不响应。

**note 按“问题序号 + 选项下标”存。** 每题一组，切题、来回移动光标都不丢；只有真正选中该选项时 note 才进入 `answers`。写完 note 又选了别的选项，note 留在原选项上，不跟着新答案走。

**重新进 note 输入框会预填原文本**，清空后回车即为删除（`setOptionNote` 里空文本走 delete 分支）。

**弹窗提醒只在 Windows 上做**（`process.platform !== "win32"` 直接返回）。其他平台工具照常可用，只是没提醒。

**弹窗用 user32 的 `MessageBox`，不是 WinForms 的 `MessageBox.Show`。** WinForms 的 `MessageBoxOptions` 枚举里没有 `TopMost`，而把 `0x40000` 强转成它会被 PowerShell 拒收（「无法将值 262144 转换为类型 MessageBoxOptions」，它校验整数必须是已定义的枚举值）。`0x50040` = `MB_TOPMOST | MB_SETFOREGROUND | MB_ICONINFORMATION`，模型往往是在别的窗口全屏时才需要这个提醒，不置顶等于没弹。

**弹窗必须 fire-and-forget。** `MessageBox` 会阻塞它自己的 powershell 进程直到用户点确定；`await pi.exec(...)` 会把提问界面一起卡住，人根本没法答题。

**文案走 base64。** 直接拼进 `-Command` 会被引号或换行截断（内容最终来自模型）。

**定时器和输入监听必须在 UI settle 时撤销**，否则用户已经答完还会收到弹窗，监听器也会在会话里越积越多。`watchPendingAnswer` 里靠 `pending.then(cancel, cancel)` 做到：`finally(cancel)` 会造出一个没人接的 promise，UI 抛错时那个 rejection 会变成 unhandledRejection。
