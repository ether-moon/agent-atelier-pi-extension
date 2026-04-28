import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { formatJson, postText } from "../lib/output.js";
import { gateOpenDir, repoRoot } from "../lib/paths.js";
import { tryReadLoopState } from "../state/loopState.js";
import { tryReadWatchdogJobs } from "../state/watchdogJobs.js";
import { tryReadWorkItems } from "../state/workItems.js";
import { renderStatusWidget } from "../ui/widgets.js";

export function registerStatusCommand(pi: ExtensionAPI): void {
  pi.registerCommand("aa-status", {
    description: "Show agent-atelier orchestration status",
    handler: async (_args, ctx) => {
      const root = repoRoot(ctx.cwd);
      const loop = tryReadLoopState(ctx.cwd);
      const workItems = tryReadWorkItems(ctx.cwd);
      const watchdog = tryReadWatchdogJobs(ctx.cwd);
      const openGateCount = countJsonFiles(gateOpenDir(root));
      const lines = renderStatusWidget({ loop, workItems, watchdog, openGateCount });
      ctx.ui.setWidget("aa-status", lines);
      postText(pi, lines.join("\n"), { loop, workItems, watchdog, openGateCount });
    }
  });
}

function countJsonFiles(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}
