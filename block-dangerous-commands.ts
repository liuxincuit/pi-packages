import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Rule {
  pattern: RegExp;
  reason: string;
}

const rules: Rule[] = [
  // 文件删除
  { pattern: /\brm\s+-[a-zA-Z]*[rfR][a-zA-Z]*/, reason: "rm -rf 是危险操作，已阻止" },
  // Git 破坏性操作
  { pattern: /^git\s+reset\s+--hard\b/, reason: "git reset --hard 是危险操作，已阻止" },
  { pattern: /^git\s+clean\b.*-[a-z]*[fd][a-z]*/, reason: "git clean -fd 是危险操作，已阻止" },
  { pattern: /^git\s+push\b/, reason: "git push 是危险操作，已阻止" },
  // 系统命令 (Linux)
  { pattern: /\bkill\b/, reason: "kill 是危险操作，已阻止" },
  { pattern: /\bshutdown\b/, reason: "shutdown 是危险操作，已阻止" },
  { pattern: /\bdd\b/, reason: "dd 是危险操作，已阻止" },
  { pattern: /\bmkfs\b/, reason: "mkfs 是危险操作，已阻止" },
  // 系统命令 (Windows)
  { pattern: /\btaskkill\b/, reason: "taskkill 是危险操作，已阻止" },
  { pattern: /\bformat\b/, reason: "format 是危险操作，已阻止" },
  // 包管理
  { pattern: /^npm\s+publish\b/, reason: "npm publish 是危险操作，已阻止" },
  { pattern: /^pip\s+uninstall\b/, reason: "pip uninstall 是危险操作，已阻止" },
];

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    for (const { pattern, reason } of rules) {
      if (pattern.test(event.input.command)) {
        return { block: true, reason };
      }
    }
  });
}
