import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("input", async (event) => {
    // 跳过扩展注入的消息，避免递归
    if (event.source === "extension") return { action: "continue" };

    // 检查是否有 skill 加载
    const hasSkills = pi.getCommands().some((cmd) => cmd.source === "skill");

    // if (hasSkills) {
    //   return {
    //     action: "transform",
    //     text: event.text + "\n\n请严格按照已加载的 skill 流程执行",
    //   };
    // }

    return { action: "continue" };
  });
}