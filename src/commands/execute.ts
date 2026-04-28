import crypto from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  optionBool,
  optionString,
  optionStrings,
  parseArgs,
  parseJsonOrFields,
  requireRequestId
} from "../lib/argparse.js";
import { formatJson, postText } from "../lib/output.js";
import { relativeStatePath } from "../lib/paths.js";
import { addMinutesIso, nowIso } from "../lib/time.js";
import type { StateTransaction, WorkItem, WorkItemsStore } from "../lib/types.js";
import { readLoopState } from "../state/loopState.js";
import { commitTx, commitVerb } from "../state/stateCommit.js";
import { bumpWorkItemsStore, cloneWorkItems, readWorkItems } from "../state/workItems.js";
import { refreshAtelierWidgets } from "../ui/refresh.js";

export function registerExecuteCommand(pi: ExtensionAPI): void {
  pi.registerCommand("aa-execute", {
    description: "Claim, heartbeat, requeue, complete, or record attempts for work items",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      const requestId = parsed.verb ? requireRequestId(parsed.options) : "";

      if (parsed.verb === "claim") {
        const id = parsed.positionals[0];
        const owner = optionString(parsed.options, "owner-session-id");
        if (!id || !owner) throw new Error("usage: /aa-execute claim <WI-ID> --owner-session-id <id> --request-id <id>");

        const store = readWorkItems(ctx.cwd);
        const next = bumpWorkItemsStore(cloneWorkItems(store));
        const item = requireItem(next, id);
        if (item.status !== "ready") throw new Error(`${id} must be ready to claim; current status is ${item.status}`);
        const now = nowIso();
        item.status = "implementing";
        item.owner_session_id = owner;
        item.first_claimed_at ??= now;
        item.last_heartbeat_at = now;
        item.lease_expires_at = addMinutesIso(Number(optionString(parsed.options, "lease-minutes") ?? 90));
        item.revision += 1;

        const result = await writeWorkItems(pi, ctx.cwd, requestId, `aa-execute claim ${id}`, store, next);
        refreshAtelierWidgets(ctx);
        postText(pi, `Claimed ${id}.\n\n${formatJson(result)}`, result);
        return;
      }

      if (parsed.verb === "heartbeat") {
        const id = parsed.positionals[0];
        if (!id) throw new Error("usage: /aa-execute heartbeat <WI-ID> --request-id <id>");
        const store = readWorkItems(ctx.cwd);
        const item = requireItem(store, id);
        if (item.status !== "implementing") throw new Error(`${id} is not implementing`);
        const result = await commitVerb(
          pi,
          ctx.cwd,
          "heartbeat",
          id,
          {
            last_heartbeat_at: nowIso(),
            lease_expires_at: addMinutesIso(Number(optionString(parsed.options, "lease-minutes") ?? 90))
          },
          store.revision
        );
        refreshAtelierWidgets(ctx);
        postText(pi, `Heartbeat recorded for ${id}.\n\n${formatJson(result)}`, result);
        return;
      }

      if (parsed.verb === "requeue") {
        const id = parsed.positionals[0];
        if (!id) throw new Error("usage: /aa-execute requeue <WI-ID> --request-id <id>");
        const store = readWorkItems(ctx.cwd);
        const next = bumpWorkItemsStore(cloneWorkItems(store));
        const item = requireItem(next, id);
        if (item.status === "done") throw new Error(`${id} is done and cannot be requeued`);
        item.status = "ready";
        item.owner_session_id = null;
        item.last_heartbeat_at = null;
        item.lease_expires_at = null;
        item.last_requeue_reason = optionString(parsed.options, "reason") ?? null;
        if (optionBool(parsed.options, "increment-stale-requeue")) item.stale_requeue_count += 1;
        if (item.promotion) {
          item.promotion = { candidate_branch: null, candidate_commit: null, status: "not_ready" };
        }
        item.revision += 1;

        const result = await writeWorkItems(pi, ctx.cwd, requestId, `aa-execute requeue ${id}`, store, next);
        refreshAtelierWidgets(ctx);
        postText(pi, `Requeued ${id}.\n\n${formatJson(result)}`, result);
        return;
      }

      if (parsed.verb === "complete") {
        const id = parsed.positionals[0];
        if (!id) throw new Error("usage: /aa-execute complete <WI-ID> --request-id <id>");
        const store = readWorkItems(ctx.cwd);
        const loop = readLoopState(ctx.cwd);
        const next = bumpWorkItemsStore(cloneWorkItems(store));
        const item = requireItem(next, id);
        if (!["reviewing", "candidate_validating", "implementing"].includes(item.status)) {
          throw new Error(`${id} cannot be completed from status ${item.status}`);
        }
        item.status = "done";
        item.completion = {
          completed_at: nowIso(),
          validation_manifest: optionString(parsed.options, "validation-manifest") ?? null,
          evidence_refs: optionStrings(parsed.options, "evidence-ref"),
          verify_checks: optionStrings(parsed.options, "verify-check")
        };
        item.revision += 1;

        const writes: StateTransaction["writes"] = [
          { path: relativeStatePath("workItems"), expected_revision: store.revision, content: next }
        ];
        const active = loop.active_candidate_set;
        if (active?.work_item_ids.includes(id)) {
          const itemMap = new Map(next.items.map((wi) => [wi.id, wi]));
          const allDone = active.work_item_ids.every((wiId) => itemMap.get(wiId)?.status === "done");
          if (allDone) {
            writes.push({
              path: relativeStatePath("loop"),
              expected_revision: loop.revision,
              content: {
                ...loop,
                revision: loop.revision + 1,
                updated_at: nowIso(),
                active_candidate_set: null,
                mode: "DONE"
              }
            });
          }
        }

        const result = await commitTx(pi, ctx.cwd, {
          request_id: requestId,
          message: `aa-execute complete ${id}`,
          writes,
          deletes: []
        });
        refreshAtelierWidgets(ctx);
        postText(pi, `Completed ${id}.\n\n${formatJson(result)}`, result);
        return;
      }

      if (parsed.verb === "attempt") {
        const payload = parseJsonOrFields(parsed.positionals, parsed.options, ctx.cwd);
        const workItemId = String(payload.work_item_id ?? payload.id ?? "");
        if (!workItemId) throw new Error("attempt payload requires work_item_id");
        const store = readWorkItems(ctx.cwd);
        const next = bumpWorkItemsStore(cloneWorkItems(store));
        const item = requireItem(next, workItemId);
        const fingerprint = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
        const attemptPath = `.agent-atelier/attempts/${workItemId}/${nowIso().replace(/[:]/g, "-")}-${fingerprint}.json`;
        item.attempt_count += 1;
        item.last_attempt_ref = attemptPath;
        item.last_finding_fingerprint = fingerprint;
        item.revision += 1;
        const result = await commitTx(pi, ctx.cwd, {
          request_id: requestId,
          message: `aa-execute attempt ${workItemId}`,
          writes: [
            { path: attemptPath, expected_revision: null, content: { ...payload, recorded_at: nowIso(), fingerprint } },
            { path: relativeStatePath("workItems"), expected_revision: store.revision, content: next }
          ],
          deletes: []
        });
        refreshAtelierWidgets(ctx);
        postText(pi, `Recorded attempt for ${workItemId}.\n\n${formatJson(result)}`, result);
        return;
      }

      throw new Error("usage: /aa-execute claim|heartbeat|requeue|complete|attempt ... --request-id <id>");
    }
  });
}

function requireItem(store: WorkItemsStore, id: string): WorkItem {
  const item = store.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`${id} not found`);
  return item;
}

async function writeWorkItems(
  pi: ExtensionAPI,
  cwd: string,
  requestId: string,
  message: string,
  previous: WorkItemsStore,
  next: WorkItemsStore
): Promise<Record<string, unknown>> {
  return commitTx(pi, cwd, {
    request_id: requestId,
    message,
    writes: [{ path: relativeStatePath("workItems"), expected_revision: previous.revision, content: next }],
    deletes: []
  });
}
