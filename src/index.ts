import fs from "node:fs";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { registerCandidateCommand } from "./commands/candidate.js";
import { registerExecuteCommand } from "./commands/execute.js";
import { registerGateCommand } from "./commands/gate.js";
import { registerInitCommand } from "./commands/init.js";
import { registerMonitorsCommand } from "./commands/monitors.js";
import { registerRunCommand, type RunState } from "./commands/run.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerValidateCommand } from "./commands/validate.js";
import { registerWatchdogCommand } from "./commands/watchdog.js";
import { registerWiCommand } from "./commands/wi.js";
import { registerAgentEndEvents } from "./events/agentEnd.js";
import { registerInputEvents } from "./events/input.js";
import { registerSessionStartEvents } from "./events/sessionStart.js";
import { registerToolCallEvents } from "./events/toolCall.js";
import { registerToolResultEvents } from "./events/toolResult.js";
import { assetPath } from "./lib/paths.js";
import { registerSubagentTool } from "./subagents/tool.js";
import { stopAllKnownMonitors } from "./commands/monitors.js";

export default function (pi: ExtensionAPI) {
  const runState: RunState = { orchestratorActive: false, coldResumeDone: false };

  pi.registerMessageRenderer("agent-atelier", (message, _options, theme) => {
    return new Text(theme.fg("accent", "agent-atelier\n") + message.content, 0, 0);
  });

  registerInitCommand(pi);
  registerStatusCommand(pi);
  registerWiCommand(pi);
  registerExecuteCommand(pi);
  registerCandidateCommand(pi);
  registerValidateCommand(pi);
  registerGateCommand(pi);
  registerWatchdogCommand(pi);
  registerMonitorsCommand(pi);
  registerRunCommand(pi, runState);
  registerSubagentTool(pi);

  pi.registerTool({
    name: "ExitPlanMode",
    label: "Exit Plan Mode",
    description: "Submit a builder-plan proposal for approval before implementation.",
    parameters: Type.Object({
      plan: Type.String({ description: "The proposed implementation plan" })
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: `Plan produced for parent approval:\n\n${params.plan}` }],
          details: { approved: false, needs_parent_approval: true, plan: params.plan },
          terminate: true
        };
      }

      const ok = await ctx.ui.confirm("Approve plan?", params.plan);
      if (ok) {
        return {
          content: [{ type: "text", text: "approved" }],
          details: { approved: true, plan: params.plan },
          terminate: true
        };
      }

      const refinement = await ctx.ui.editor("Refine the plan", params.plan);
      return {
        content: [{ type: "text", text: refinement ? `not approved; refinement:\n${refinement}` : "not approved" }],
        details: { approved: false, refinement: refinement ?? "", plan: params.plan }
      };
    }
  });

  registerSessionStartEvents(pi);
  registerInputEvents(pi);
  registerToolCallEvents(pi);
  registerAgentEndEvents(pi);
  registerToolResultEvents(pi);

  pi.on("session_shutdown", async (_event, ctx) => {
    stopAllKnownMonitors(ctx.cwd);
  });

  pi.on("before_agent_start", async (event) => {
    if (!runState.orchestratorActive) return;
    const orchestratorPrompt = fs.readFileSync(assetPath("prompts", "orchestrator.md"), "utf-8");
    return {
      systemPrompt: `${event.systemPrompt}\n\n${orchestratorPrompt}\n\nUse pi commands named /aa-* instead of Claude plugin commands. Delegate with the aa-subagent tool when specialist agents are needed.`
    };
  });
}
