import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event, ctx) => {
    const model = ctx.model;
    if (!model) return;

    return {
      systemPrompt: event.systemPrompt + `\n\n当前模型: ${model.id}`,
    };
  });
}
