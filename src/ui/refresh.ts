import fs from "node:fs";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { gateOpenDir, repoRoot } from "../lib/paths.js";
import { tryReadLoopState } from "../state/loopState.js";
import { tryReadWatchdogJobs } from "../state/watchdogJobs.js";
import { tryReadWorkItems } from "../state/workItems.js";
import { renderStatusWidget } from "./widgets.js";

export function refreshAtelierWidgets(ctx: ExtensionContext): void {
  const root = repoRoot(ctx.cwd);
  const lines = renderStatusWidget({
    loop: tryReadLoopState(ctx.cwd),
    workItems: tryReadWorkItems(ctx.cwd),
    watchdog: tryReadWatchdogJobs(ctx.cwd),
    openGateCount: countJsonFiles(gateOpenDir(root))
  });
  ctx.ui.setWidget("aa-active-wis", lines);
  ctx.ui.setWidget("aa-status", lines);
}

function countJsonFiles(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}
