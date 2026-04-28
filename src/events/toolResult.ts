import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { refreshAtelierWidgets } from "../ui/refresh.js";

export function registerToolResultEvents(pi: ExtensionAPI): void {
  pi.on("tool_result", async (_event, ctx) => {
    refreshAtelierWidgets(ctx);
  });
}
