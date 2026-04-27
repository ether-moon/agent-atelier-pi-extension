import fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parseArgs } from "../lib/argparse.js";
import { formatJson, postText } from "../lib/output.js";
import { gateIndexPath, repoRoot, relativeStatePath } from "../lib/paths.js";
import { nowIso } from "../lib/time.js";
import type { StateTransaction } from "../lib/types.js";
import { commitTx } from "../state/stateCommit.js";
import { refreshAtelierWidgets } from "../ui/refresh.js";

export function registerInitCommand(pi: ExtensionAPI): void {
  pi.registerCommand("aa-init", {
    description: "Bootstrap .agent-atelier state files",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      const force = parsed.options.force === true;
      const root = repoRoot(ctx.cwd);
      const now = nowIso();

      const defaults = {
        loop: {
          revision: 1,
          updated_at: now,
          mode: "DISCOVER",
          active_spec: "docs/product/behavior-spec.md",
          active_spec_revision: 1,
          open_gates: [],
          active_candidate_set: null,
          candidate_queue: [],
          team_name: null,
          next_action: {
            owner: "orchestrator",
            type: "draft_first_work_item",
            target: null
          }
        },
        workItems: {
          revision: 1,
          updated_at: now,
          items: []
        },
        watchdogJobs: {
          revision: 1,
          updated_at: now,
          defaults: {
            implementing_timeout_minutes: 90,
            candidate_timeout_minutes: 30,
            review_timeout_minutes: 30,
            gate_warn_after_hours: 24
          },
          budgets: {
            max_wall_clock_minutes_per_wi: 480,
            max_handoffs_per_wi: 6,
            max_watchdog_interventions_per_wi: 3,
            max_attempts_per_wi: 5
          },
          open_alerts: [],
          last_tick_at: now
        }
      };

      const writes: StateTransaction["writes"] = [];
      maybeWriteJson(root, relativeStatePath("loop"), defaults.loop, force, writes);
      maybeWriteJson(root, relativeStatePath("workItems"), defaults.workItems, force, writes);
      maybeWriteJson(root, relativeStatePath("watchdogJobs"), defaults.watchdogJobs, force, writes);

      if (force || !fs.existsSync(gateIndexPath(root))) {
        writes.push({
          path: ".agent-atelier/human-gates/_index.md",
          expected_revision: null,
          content: renderGateIndex([], [])
        });
      }

      if (writes.length === 0) {
        postText(pi, "agent-atelier state already initialized.");
        return;
      }

      const result = await commitTx(pi, ctx.cwd, {
        message: "aa-init",
        writes,
        deletes: []
      });

      refreshAtelierWidgets(ctx);
      postText(pi, `Initialized agent-atelier state.\n\n${formatJson(result)}`, result);
    }
  });
}

function maybeWriteJson(
  root: string,
  relPath: string,
  content: Record<string, unknown>,
  force: boolean,
  writes: StateTransaction["writes"]
): void {
  const fullPath = `${root}/${relPath}`;
  if (!force && fs.existsSync(fullPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(fullPath, "utf-8")) as { revision?: number };
      if ((existing.revision ?? 0) >= 1) return;
    } catch {
      // Replace unreadable state with the canonical default.
    }
  }
  writes.push({ path: relPath, expected_revision: force ? readRevision(fullPath) : null, content });
}

function readRevision(fullPath: string): number | null {
  try {
    return (JSON.parse(fs.readFileSync(fullPath, "utf-8")) as { revision?: number }).revision ?? null;
  } catch {
    return null;
  }
}

export function renderGateIndex(open: Array<{ id: string; question: string | null; created_at: string | null }>, resolved: Array<{ id: string; question: string | null; chosen_option: string | null; resolved_at: string | null }>): string {
  const openRows =
    open.length === 0
      ? "| - | (none) | - | - | - | - |"
      : open.map((gate) => `| ${gate.id} | ${gate.question ?? ""} | - | - | - | ${gate.created_at ?? ""} |`).join("\n");
  const resolvedRows =
    resolved.length === 0
      ? "| - | (none) | - | - |"
      : resolved
          .map((gate) => `| ${gate.id} | ${gate.question ?? ""} | ${gate.chosen_option ?? ""} | ${gate.resolved_at ?? ""} |`)
          .join("\n");

  return `# Human Gate Dashboard

## Open Gates

| ID | Question | Triggered By | Blocking? | Blocked Items | Created |
|----|----------|-------------|-----------|---------------|---------|
${openRows}

## Resolved Gates

| ID | Question | Chosen Option | Resolved At |
|----|----------|--------------|-------------|
${resolvedRows}
`;
}
