import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  if (process.platform !== "win32") return;
  let lastInputTime = 0;
  let notifyTimer: ReturnType<typeof setTimeout> | null = null;
  let agentRunning = false;
  let hasUI = false;
  let unsubscribeInput: (() => void) | null = null;

  pi.on("session_start", async (_event, ctx) => {
    hasUI = ctx.hasUI;
    if (!hasUI) return;

    // 监听原始终端输入，不依赖编辑器组件：不受其他扩展 setEditorComponent 覆盖影响
    unsubscribeInput = ctx.ui.onTerminalInput(() => {
      lastInputTime = Date.now();
      if (notifyTimer) {
        clearTimeout(notifyTimer);
        notifyTimer = null;
      }
    });
  });

  pi.on("agent_start", async () => {
    agentRunning = true;
    if (notifyTimer) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
    }
  });

  pi.on("agent_end", async (event) => {
    if (!hasUI) return;
    agentRunning = false;

    if (notifyTimer) clearTimeout(notifyTimer);

    const lastMessage = event.messages[event.messages.length - 1];
    const stopReason = lastMessage?.role === "assistant" ? lastMessage.stopReason : undefined;

    if (stopReason === "aborted") return;

    const agentEndTime = Date.now();
    const delay = stopReason === "error" ? 20000 : 10000;

    notifyTimer = setTimeout(async () => {
      notifyTimer = null;
      if (agentRunning) return;
      if (lastInputTime > agentEndTime) return;

      try {
        await pi.exec("powershell", [
          "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; " +
            "[System.Windows.Forms.MessageBox]::Show('pi 已完成回复', 'pi')",
        ]);
      } catch {}
    }, delay);
  });

  pi.on("session_shutdown", async () => {
    unsubscribeInput?.();
    unsubscribeInput = null;
    if (notifyTimer) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
    }
  });
}
