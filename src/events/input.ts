import fs from "node:fs";
import { pendingTxPath, repoRoot } from "../lib/paths.js";
import { tryReadLoopState } from "../state/loopState.js";

export function registerInputEvents(pi: import("@mariozechner/pi-coding-agent").ExtensionAPI): void {
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" as const };
    const root = repoRoot(ctx.cwd);
    const loop = tryReadLoopState(ctx.cwd);
    if (!loop) return { action: "continue" as const };

    const context: string[] = [];
    if (loop.open_gates.length) context.push(`open_gates=${loop.open_gates.join(",")}`);
    if (loop.active_candidate_set) context.push(`active_candidate_set=${loop.active_candidate_set.id}`);
    if (fs.existsSync(pendingTxPath(root))) context.push("pending_tx=true");
    if (context.length === 0) return { action: "continue" as const };

    return {
      action: "transform" as const,
      text: `${event.text}\n\n[atelier context: ${context.join(" ")}]`,
      images: event.images
    };
  });
}
