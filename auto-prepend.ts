/**
 * auto-prepend — Pi extension that auto-injects a custom message after N rounds.
 *
 * Configuration: ~/.pi/agent/auto-prepend.json
 * Commands:
 *   /auto-prepend          Show status
 *   /auto-prepend status   Show status
 *   /auto-prepend init     Create default config file
 */

import fs from "node:fs";
import path from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Config {
  enabled: boolean;
  interval: number;
  message: string;
}

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_FILE = path.join(
  process.env.HOME || process.env.USERPROFILE || "",
  ".pi",
  "agent",
  "auto-prepend.json",
);

const DEFAULT_CONFIG: Config = {
  enabled: true,
  interval: 7,
  message: "请详细解释你的推理过程",
};

function readConfig(): Config {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return {
      enabled:
        typeof parsed.enabled === "boolean"
          ? parsed.enabled
          : DEFAULT_CONFIG.enabled,
      interval:
        typeof parsed.interval === "number" && parsed.interval > 0
          ? parsed.interval
          : DEFAULT_CONFIG.interval,
      message:
        typeof parsed.message === "string"
          ? parsed.message
          : DEFAULT_CONFIG.message,
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ── Extension ─────────────────────────────────────────────────────────────────

export default function autoPrepend(pi: ExtensionAPI) {
  let roundCount = 0;
  let config: Config = readConfig();

  // ── Session start: rebuild counter from history ──────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    config = readConfig();
    roundCount = 0;

    // Rebuild counter from session history so resumed sessions (pi -r)
    // continue counting from where they left off.
    try {
      const entries = ctx.sessionManager.getBranch();
      let assistantCount = 0;
      for (const entry of entries) {
        if (
          entry.type === "message" &&
          (entry as { role?: string }).role === "assistant"
        ) {
          assistantCount++;
        }
      }
      roundCount = assistantCount % config.interval;
    } catch {
      // sessionManager may not be fully available in some contexts
    }
  });

  // ── Before agent starts: inject if threshold reached ────────────────────
  pi.on("before_agent_start", async (event) => {
    // Re-read config each turn to pick up any file edits mid-session
    config = readConfig();
    if (!config.enabled) return;

    if (roundCount >= config.interval) {
      roundCount = 0;

      return {
        message: {
          customType: "auto-prepend",
          content: config.message,
          display: true,
        },
      };
    }
  });

  // ── Agent end: count one round ──────────────────────────────────────────
  pi.on("agent_end", async () => {
    if (!config.enabled) return;
    roundCount++;
  });

  // ── Commands ────────────────────────────────────────────────────────────
  pi.registerCommand("auto-prepend", {
    description:
      "Show auto-prepend status/config. Usage: /auto-prepend [status|init]",
    handler: async (args, ctx) => {
      const trimmed = args.trim().toLowerCase();

      if (trimmed === "init") {
        try {
          const dir = path.dirname(CONFIG_FILE);
          fs.mkdirSync(dir, { recursive: true });

          if (!fs.existsSync(CONFIG_FILE)) {
            fs.writeFileSync(
              CONFIG_FILE,
              JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n",
              "utf-8",
            );
            ctx.ui.notify(`Created default config at ${CONFIG_FILE}`, "info");
          } else {
            ctx.ui.notify(
              `Config already exists at ${CONFIG_FILE}`,
              "info",
            );
          }
        } catch (err) {
          ctx.ui.notify(
            `Failed to create config: ${String(err)}`,
            "error",
          );
        }
        return;
      }

      // Default / status
      const nextIn =
        roundCount >= config.interval
          ? 0
          : config.interval - roundCount;

      ctx.ui.notify(
        [
          `auto-prepend: ${config.enabled ? "enabled" : "disabled"}`,
          `interval: ${config.interval}`,
          `round: ${roundCount}/${config.interval}`,
          nextIn === 0
            ? "will trigger on next message"
            : `next trigger in ${nextIn} round(s)`,
          `message: "${config.message}"`,
        ].join(" | "),
        "info",
      );
    },
  });
}
