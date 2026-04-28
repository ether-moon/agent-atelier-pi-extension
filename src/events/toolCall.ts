import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isDestructive } from "../lib/destructiveCommands.js";
import { isSafeCommand } from "../lib/safeBash.js";

// Plan-mode bash gating relies on the AA_ACTIVE_AGENT env var, which is set
// by subagents/spawn.ts on the spawned child process and inherited by any
// further pi processes that the child itself spawns. The handler runs inside
// the same process whose tool calls it should restrict, so checking the
// process env is sufficient: the parent orchestrator never has the var set,
// builder-plan children always do. Defense-in-depth: agents/builder-plan.md
// also lists a restricted `tools:` set that pi enforces at spawn time.
export function registerToolCallEvents(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash") return;
    const input = event.input as { command?: string };
    const command = input.command ?? "";
    if (process.env.AA_ACTIVE_AGENT === "builder-plan" && !isSafeCommand(command)) {
      return { block: true, reason: "builder-plan may only run read-only shell commands" };
    }
    const check = isDestructive(command);
    if (check.block) return { block: true, reason: check.reason };
  });
}
