import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 拦截 bash 命令中的 `> nul` 重定向，替换为 `> /dev/null`。
 *
 * 根因：pi 默认用 Git Bash (MSYS2) 执行命令，MSYS2 将 `nul` 视为普通文件名，
 * 会在当前目录创建真实文件 "nul"，且 Windows 设备名限制使其无法被正常删除。
 */
export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;

    const original = event.input.command;

    // 匹配 > nul, >nul, > NUL, >NUL 等，支持 1> 和 2> 前缀
    const replaced = original.replace(
      /(?:[12]?>\s*)nul\b/gi,
      (match) => {
        // 保留重定向符号部分，只替换 nul 为 /dev/null
        const prefix = match.replace(/nul\b/i, "");
        return `${prefix}/dev/null`;
      },
    );

    if (replaced !== original) {
      event.input.command = replaced;
    }
  });
}
