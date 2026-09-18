# notify-on-reply

Windows 上收到回复时弹系统通知。

## 做什么

agent 回复结束后弹一个 `MessageBox`（`System.Windows.Forms`），提示"pi 已完成回复"。

时序：`agent_end` 后延迟等待——正常结束 10 秒，`stopReason === "error"` 时 20 秒——然后弹窗。等待期间若用户已经输入、或新的 agent 已启动、或 `stopReason === "aborted"`，则取消弹窗。

## 配置

无。延迟时长硬编码在源码里。

## 调试

跑一轮对话，然后在 10 秒内不动键盘，应看到弹窗。在 10 秒内敲任意键应不弹。

## 陷阱

**仅 Windows。** 进程启动时判断 `process.platform !== "win32"` 就直接返回，其他平台下整个扩展不注册任何处理。

**输入监听走 `ctx.ui.onTerminalInput`，不是编辑器组件。** 挂编辑器组件会被其他扩展的 `setEditorComponent` 覆盖（本仓库的 persistent-history 就在做这件事），而 `onTerminalInput` 不受影响。

无 UI 的会话（`ctx.hasUI` 为 false）下不注册监听，`agent_end` 也直接返回。

`session_shutdown` 里会解绑输入监听并清掉定时器。
