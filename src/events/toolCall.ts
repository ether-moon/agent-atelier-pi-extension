import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isDestructive } from "../lib/destructiveCommands.js";
import { isSafeCommand } from "../lib/safeBash.js";

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
