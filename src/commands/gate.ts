import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { optionString, parseArgs, parseJsonOrFields, requireRequestId } from "../lib/argparse.js";
import { formatJson, postText } from "../lib/output.js";
import { gateOpenDir, gateResolvedDir, relativeStatePath, repoRoot } from "../lib/paths.js";
import { nowIso } from "../lib/time.js";
import type { HumanGate, StateTransaction } from "../lib/types.js";
import { readLoopState } from "../state/loopState.js";
import { commitTx } from "../state/stateCommit.js";
import { refreshAtelierWidgets } from "../ui/refresh.js";
import { renderGateIndex } from "./init.js";

export function registerGateCommand(pi: ExtensionAPI): void {
  pi.registerCommand("aa-gate", {
    description: "List, open, or resolve human decision gates",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      if (parsed.verb === "list" || parsed.verb === "") {
        const root = repoRoot(ctx.cwd);
        const gates = readGates(root);
        postText(pi, formatGateList(gates.open, gates.resolved), gates);
        return;
      }

      if (parsed.verb === "open") {
        const requestId = requireRequestId(parsed.options);
        const root = repoRoot(ctx.cwd);
        const loop = readLoopState(ctx.cwd);
        const payload = parseJsonOrFields(parsed.positionals, parsed.options, ctx.cwd);
        const gates = readGates(root);
        const gate = normalizeGate(payload, nextGateId(gates), loop.revision);
        const nextLoop = {
          ...loop,
          revision: loop.revision + 1,
          updated_at: nowIso(),
          open_gates: Array.from(new Set([...loop.open_gates, gate.id]))
        };

        const writes: StateTransaction["writes"] = [
          { path: `.agent-atelier/human-gates/open/${gate.id}.json`, expected_revision: null, content: gate },
          { path: relativeStatePath("loop"), expected_revision: loop.revision, content: nextLoop },
          {
            path: ".agent-atelier/human-gates/_index.md",
            expected_revision: null,
            content: renderGateIndex([...gates.open, gate], gateIndexResolved(gates.resolved))
          }
        ];

        const result = await commitTx(pi, ctx.cwd, {
          request_id: requestId,
          message: `aa-gate open ${gate.id}`,
          writes,
          deletes: []
        });
        refreshAtelierWidgets(ctx);
        postText(pi, `Opened ${gate.id}.\n\n${formatJson(result)}`, result);
        return;
      }

      if (parsed.verb === "resolve") {
        const requestId = requireRequestId(parsed.options);
        const id = parsed.positionals[0] ?? optionString(parsed.options, "id");
        const chosen = parsed.positionals[1] ?? optionString(parsed.options, "chosen-option");
        if (!id || !chosen) throw new Error("usage: /aa-gate resolve <HDR-ID> <chosen-option> --request-id <id>");

        const root = repoRoot(ctx.cwd);
        const loop = readLoopState(ctx.cwd);
        const gates = readGates(root);
        const gate = gates.open.find((entry) => entry.id === id);
        if (!gate) throw new Error(`${id} is not an open gate`);

        const resolvedAt = nowIso();
        const resolvedGate: HumanGate = {
          ...gate,
          state: "resolved",
          resolution: {
            ...gate.resolution,
            resolved_at: resolvedAt,
            chosen_option: chosen,
            user_notes: optionString(parsed.options, "notes") ?? gate.resolution.user_notes
          }
        };
        const nextLoop = {
          ...loop,
          revision: loop.revision + 1,
          updated_at: resolvedAt,
          open_gates: loop.open_gates.filter((gateId) => gateId !== id)
        };
        const nextOpen = gates.open.filter((entry) => entry.id !== id);
        const nextResolved = [...gates.resolved, resolvedGate];

        const result = await commitTx(pi, ctx.cwd, {
          request_id: requestId,
          message: `aa-gate resolve ${id}`,
          writes: [
            { path: `.agent-atelier/human-gates/resolved/${id}.json`, expected_revision: null, content: resolvedGate },
            { path: relativeStatePath("loop"), expected_revision: loop.revision, content: nextLoop },
            {
              path: ".agent-atelier/human-gates/_index.md",
              expected_revision: null,
              content: renderGateIndex(nextOpen, gateIndexResolved(nextResolved))
            }
          ],
          deletes: [`.agent-atelier/human-gates/open/${id}.json`]
        });
        refreshAtelierWidgets(ctx);
        postText(pi, `Resolved ${id} with ${chosen}.\n\n${formatJson(result)}`, result);
        return;
      }

      throw new Error("usage: /aa-gate list | open <json> --request-id <id> | resolve <HDR-ID> <choice> --request-id <id>");
    }
  });
}

function readGates(root: string): { open: HumanGate[]; resolved: HumanGate[] } {
  return {
    open: readGateDir(gateOpenDir(root)),
    resolved: readGateDir(gateResolvedDir(root))
  };
}

function readGateDir(dir: string): HumanGate[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")) as HumanGate);
  } catch {
    return [];
  }
}

function nextGateId(gates: { open: HumanGate[]; resolved: HumanGate[] }): string {
  const max = [...gates.open, ...gates.resolved].reduce((highest, gate) => {
    const match = /^HDR-(\d+)$/.exec(gate.id);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `HDR-${String(max + 1).padStart(3, "0")}`;
}

function normalizeGate(payload: Record<string, unknown>, fallbackId: string, stateRevision: number): HumanGate {
  return {
    id: String(payload.id ?? fallbackId),
    created_at: String(payload.created_at ?? nowIso()),
    state_revision: Number(payload.state_revision ?? stateRevision),
    triggered_by: (payload.triggered_by as string | null | undefined) ?? null,
    state: "open",
    question: (payload.question as string | null | undefined) ?? null,
    why_now: (payload.why_now as string | null | undefined) ?? null,
    context: (payload.context as string | null | undefined) ?? null,
    gate_criteria: (payload.gate_criteria as Record<string, unknown> | undefined) ?? {
      irreversibility: null,
      blast_radius: null,
      product_meaning_change: null
    },
    options: Array.isArray(payload.options) ? (payload.options as string[]) : [],
    recommended_option: (payload.recommended_option as string | null | undefined) ?? null,
    blocking: Boolean(payload.blocking),
    blocked_work_items: Array.isArray(payload.blocked_work_items) ? (payload.blocked_work_items as string[]) : [],
    unblocked_work_items: Array.isArray(payload.unblocked_work_items) ? (payload.unblocked_work_items as string[]) : [],
    resume_target: (payload.resume_target as string | null | undefined) ?? null,
    default_if_no_response: String(payload.default_if_no_response ?? "continue_unblocked_work"),
    linked_escalations: Array.isArray(payload.linked_escalations) ? (payload.linked_escalations as string[]) : [],
    resolution: {
      resolved_at: null,
      chosen_option: null,
      user_notes: null,
      follow_up_actions: []
    }
  };
}

function formatGateList(open: HumanGate[], resolved: HumanGate[]): string {
  const openText =
    open.length === 0
      ? "Open gates: none"
      : `Open gates:\n${open.map((gate) => `${gate.id}: ${gate.question ?? "(no question)"}`).join("\n")}`;
  const resolvedText =
    resolved.length === 0
      ? "Resolved gates: none"
      : `Resolved gates:\n${resolved.map((gate) => `${gate.id}: ${gate.resolution.chosen_option ?? "(no choice)"}`).join("\n")}`;
  return `${openText}\n\n${resolvedText}`;
}

function gateIndexResolved(gates: HumanGate[]): Array<{
  id: string;
  question: string | null;
  chosen_option: string | null;
  resolved_at: string | null;
}> {
  return gates.map((gate) => ({
    id: gate.id,
    question: gate.question,
    chosen_option: gate.resolution.chosen_option,
    resolved_at: gate.resolution.resolved_at
  }));
}
