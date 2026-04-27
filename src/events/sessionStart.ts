import fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { pendingTxPath, repoRoot, stateExists } from "../lib/paths.js";
import { replayPendingTx } from "../state/stateCommit.js";

export function registerSessionStartEvents(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const root = repoRoot(ctx.cwd);
    if (!stateExists(root)) {
      ctx.ui.notify("Run /aa-init to bootstrap agent-atelier state.", "info");
      return;
    }
    if (fs.existsSync(pendingTxPath(root))) {
      try {
        await replayPendingTx(pi, ctx.cwd);
        ctx.ui.notify("Replayed pending agent-atelier state transaction.", "info");
      } catch (error) {
        ctx.ui.notify(`agent-atelier WAL replay failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
  });
}
