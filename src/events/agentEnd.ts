import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { refreshAtelierWidgets } from "../ui/refresh.js";

export function registerAgentEndEvents(pi: ExtensionAPI): void {
  pi.on("agent_end", async (_event, ctx) => {
    refreshAtelierWidgets(ctx);
  });
}
