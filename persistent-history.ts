/**
 * Persistent Input History
 *
 * Preserves editor input history across /reload, /new, and new pi sessions.
 * Each pi process writes to its own history file to avoid concurrent write conflicts.
 * New sessions merge history from the last 7 days.
 *
 * Storage: .pi/input-history/<timestamp>_<pid>  (JSONL, one file per session)
 *
 * How it works:
 *   - On session start, reads history files from the last 7 days sorted by mtime
 *   - On submission, appends to the current session's own file only
 *   - Session isolation: concurrent pi instances in same dir write to different files
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, appendFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    const historyDir = `${ctx.cwd}/.pi/input-history`;
    const sessionFile = `${Date.now()}_${process.pid}`;

    class PersistentHistoryEditor extends CustomEditor {
      constructor(tui: any, theme: any, keybindings: any) {
        super(tui, theme, keybindings);
        this.restoreHistory(historyDir);
      }

      override addToHistory(text: string): void {
        super.addToHistory(text);
        this.persistEntry(text, historyDir, sessionFile);
      }

      private restoreHistory(dir: string): void {
        try {
          const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
          const files = readdirSync(dir)
            .filter((f) => /^\d+_\d+$/.test(f))
            .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
            .filter((f) => f.mtime >= cutoff)
            .sort((a, b) => a.mtime - b.mtime);

          for (const file of files) {
            const content = readFileSync(join(dir, file.name), "utf-8");
            for (const line of content.trim().split("\n").filter(Boolean)) {
              try {
                super.addToHistory(JSON.parse(line));
              } catch {
                // Skip corrupt lines
              }
            }
          }
        } catch {
          // Directory doesn't exist or can't be read — start fresh
        }
      }

      private persistEntry(text: string, dir: string, file: string): void {
        try {
          mkdirSync(dir, { recursive: true });
          appendFileSync(join(dir, file), JSON.stringify(text) + "\n");
        } catch {
          // Silently ignore write failures
        }
      }
    }

    ctx.ui.setEditorComponent(
      (tui, theme, kb) => new PersistentHistoryEditor(tui, theme, kb),
    );
  });
}
