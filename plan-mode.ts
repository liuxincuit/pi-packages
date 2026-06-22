/**
 * pi-plan-mode — A minimal plan-mode extension for pi.
 *
 * /plan         → enter read-only mode (write/edit blocked, mutating bash blocked)
 * /plan off     → exit read-only mode, restore full tool access
 * /plan <msg>   → enter read-only mode and send a message
 *
 * When active, built-in write/edit tools are removed from the LLM's tool list,
 * and any mutating bash commands (rm, mv, >, git commit, etc.) are blocked at
 * runtime via the tool_call event interceptor.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Bash command safety  ──────────────────────────────────────────────────────
// Allowlisted safe read-only commands.
const SAFE_BASH_PATTERNS = [
  /^\s*(cat|head|tail|less|more|grep|find|ls|pwd|echo|printf|wc|sort|uniq|diff|file|stat|du|df|tree|which|whereis|type|env|printenv|uname|whoami|id|date|uptime|ps|jq|awk|rg|fd|bat|eza)\b/i,
  /^\s*sed\s+-n\b/i,
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-files|grep)\b/i,
  /^\s*npm\s+(list|ls|view|info|search|outdated|audit)\b/i,
  /^\s*(node|python|python3|npm|tsc|biome|ruff|ty)\s+--version\b/i,
];

// Patterns that indicate a mutating command (blocked).
const MUTATING_BASH_PATTERNS = [
  /\brm\b/i,
  /\brmdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\bmkdir\b/i,
  /\btouch\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\btee\b/i,
  /\bdd\b/i,
  /(^|[^<])>(?!>)/, // > redirect (excluding <)
  />>/,
  /\bnpm\s+(install|uninstall|update|ci|link|publish|version)\b/i,
  /\byarn\s+(add|remove|install|publish|upgrade)\b/i,
  /\bpnpm\s+(add|remove|install|publish|update)\b/i,
  /\bpip\s+(install|uninstall)\b/i,
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|switch|stash|cherry-pick|revert|tag|init|clone)\b/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bkill\b/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)\b/i,
  /\b(vim?|nano|emacs|code|subl)\b/i,
];

function isSafeCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (MUTATING_BASH_PATTERNS.some((p) => p.test(trimmed))) return false;
  return SAFE_BASH_PATTERNS.some((p) => p.test(trimmed));
}

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"];

/**
 * Parse the bash command string from the tool input.
 * bash tool input is { command: string }.
 */
function bashCommand(input: unknown): string {
  const cmd = input as { command?: unknown } | undefined;
  return typeof cmd?.command === "string" ? cmd.command : "";
}

/** Plan mode 指令，追加到 system prompt 尾部。 */
const PLAN_MODE_PROMPT = `
[Plan Mode Active]
You are currently in Plan Mode — you can only read files and search code.
You MUST NOT create, edit, or delete any files.
Discuss and plan with the user, but do not make any changes.
If you need to modify files, ask the user to exit Plan Mode first.
`;

// ── Extension  ────────────────────────────────────────────────────────────────

export default function planMode(pi: ExtensionAPI) {
  let enabled = false;
  let previousTools: string[] | undefined;

  pi.registerCommand("plan", {
    description: "Enter or exit Plan mode (read-only). /plan off to exit.",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const lower = trimmed.toLowerCase();

      // Exit plan mode
      if (lower === "exit" || lower === "off") {
        if (!enabled) {
          ctx.ui.notify("Plan mode is not active.", "info");
          return;
        }
        enabled = false;
        if (previousTools) {
          pi.setActiveTools(previousTools);
          previousTools = undefined;
        }
        ctx.ui.setStatus("plan-mode", undefined);
        ctx.ui.notify("Plan mode off — full tool access restored.", "info");
        return;
      }

      // Enter plan mode
      if (enabled) {
        if (trimmed) {
          // Already in plan mode, send the message as user input
          pi.sendUserMessage(trimmed, { deliverAs: "followUp" });
        }
        return;
      }

      // Save current tools and set read-only
      previousTools = pi.getActiveTools();
      enabled = true;
      pi.setActiveTools(READ_ONLY_TOOLS);
      ctx.ui.setStatus("plan-mode", "plan active");
      ctx.ui.notify("Plan mode on — read only. /plan off to exit.", "info");

      // If a message was provided, forward it to the conversation
      if (trimmed) {
        pi.sendUserMessage(trimmed, { deliverAs: "followUp" });
      }
    },
  });

  // ── Tool-call interception ──────────────────────────────────────────────
  pi.on("tool_call", async (event, _ctx) => {
    if (!enabled) return;

    // Block write/edit at the tool level
    if (event.toolName === "write" || event.toolName === "edit") {
      return {
        block: true,
        reason: "Plan mode is active — file modification is disabled. Use /plan off to exit plan mode and restore write access.",
      };
    }

    // Block mutating bash commands
    if (event.toolName === "bash") {
      const command = bashCommand(event.input);
      if (command && !isSafeCommand(command)) {
        return {
          block: true,
          reason: `Plan mode blocks mutating bash commands.\nCommand: ${command}\nUse read-only commands (cat, grep, find, ls, git log, etc.) or exit plan mode with /plan off.`,
        };
      }
    }
  });

  // ── 子 Agent 也受 plan mode 约束 ───────────────────────────────────────
  // 主会话 /plan 只约束了主会话自己的工具列表。如果 LLM 在 plan mode
  // 下调用 Agent 工具创建子 Agent，默认它拥有 write/edit 权限，可以绕过
  // 只读限制。这个钩子在子 Agent 启动前注入只读指令并强制其工具集。
  pi.on("before_agent_start", (event) => {
    if (!enabled) return;
    // 强制子 Agent 也只读，并追加 plan mode 指令
    pi.setActiveTools(READ_ONLY_TOOLS);
    return {
      systemPrompt: `${event.systemPrompt}\n${PLAN_MODE_PROMPT}`,
    };
  });

  // ── Session lifecycle ───────────────────────────────────────────────────
  pi.on("session_shutdown", () => {
    enabled = false;
    previousTools = undefined;
  });
}
