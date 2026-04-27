import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { optionString, parseArgs, requireRequestId } from "../lib/argparse.js";
import { formatJson, postText } from "../lib/output.js";
import { relativeStatePath } from "../lib/paths.js";
import { nowIso } from "../lib/time.js";
import type { CandidateSet, StateTransaction, WorkItemsStore } from "../lib/types.js";
import { readLoopState } from "../state/loopState.js";
import { commitTx } from "../state/stateCommit.js";
import { bumpWorkItemsStore, cloneWorkItems, readWorkItems } from "../state/workItems.js";
import { refreshAtelierWidgets } from "../ui/refresh.js";

export function registerCandidateCommand(pi: ExtensionAPI): void {
  pi.registerCommand("aa-candidate", {
    description: "Enqueue, activate, or clear candidate sets",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      const requestId = parsed.verb ? requireRequestId(parsed.options) : "";

      if (parsed.verb === "enqueue") {
        const ids = (parsed.positionals[0] ?? "").split(",").map((id) => id.trim()).filter(Boolean);
        const branch = optionString(parsed.options, "branch");
        const commit = optionString(parsed.options, "commit");
        if (ids.length === 0 || !branch || !commit) {
          throw new Error("usage: /aa-candidate enqueue WI-001[,WI-002] --branch <name> --commit <sha> --request-id <id>");
        }

        const loop = readLoopState(ctx.cwd);
        const store = readWorkItems(ctx.cwd);
        const nextWork = bumpWorkItemsStore(cloneWorkItems(store));
        for (const id of ids) {
          const item = requireCandidateItem(nextWork, id);
          if (item.status !== "implementing") throw new Error(`${id} must be implementing; current status is ${item.status}`);
          item.status = "candidate_queued";
          item.owner_session_id = null;
          item.last_heartbeat_at = null;
          item.lease_expires_at = null;
          item.promotion = { candidate_branch: branch, candidate_commit: commit, status: "candidate_queued" };
          item.revision += 1;
        }

        const candidate: CandidateSet = {
          id: nextCandidateId(loop.active_candidate_set ? [loop.active_candidate_set, ...loop.candidate_queue] : loop.candidate_queue),
          work_item_ids: ids,
          branch,
          commit,
          type: ids.length === 1 ? "single" : "batch",
          activated_at: null
        };
        ensureNotQueued(loop, ids);
        const nextLoop = {
          ...loop,
          revision: loop.revision + 1,
          updated_at: nowIso(),
          candidate_queue: [...loop.candidate_queue, candidate],
          next_action: { owner: "orchestrator", type: "activate_candidate", target: candidate.id }
        };

        const result = await commitTx(pi, ctx.cwd, {
          request_id: requestId,
          message: `aa-candidate enqueue ${candidate.id}`,
          writes: txWrites(loop.revision, nextLoop, store.revision, nextWork),
          deletes: []
        });
        refreshAtelierWidgets(ctx);
        postText(pi, `Enqueued ${candidate.id}.\n\n${formatJson(result)}`, result);
        return;
      }

      if (parsed.verb === "activate") {
        const loop = readLoopState(ctx.cwd);
        if (loop.active_candidate_set) throw new Error(`candidate slot already occupied by ${loop.active_candidate_set.id}`);
        const [candidate, ...queue] = loop.candidate_queue;
        if (!candidate) throw new Error("candidate queue is empty");

        const store = readWorkItems(ctx.cwd);
        const nextWork = bumpWorkItemsStore(cloneWorkItems(store));
        for (const id of candidate.work_item_ids) {
          const item = requireCandidateItem(nextWork, id);
          if (item.status !== "candidate_queued") throw new Error(`${id} must be candidate_queued; current status is ${item.status}`);
          item.status = "candidate_validating";
          item.promotion.status = "candidate_validating";
          item.revision += 1;
        }

        const active = { ...candidate, activated_at: nowIso() };
        const nextLoop = {
          ...loop,
          revision: loop.revision + 1,
          updated_at: nowIso(),
          mode: "CANDIDATE_VALIDATE",
          active_candidate_set: active,
          candidate_queue: queue,
          next_action: { owner: "vrm", type: "validate_candidate", target: active.id }
        };

        const result = await commitTx(pi, ctx.cwd, {
          request_id: requestId,
          message: `aa-candidate activate ${active.id}`,
          writes: txWrites(loop.revision, nextLoop, store.revision, nextWork),
          deletes: []
        });
        refreshAtelierWidgets(ctx);
        postText(pi, `Activated ${active.id}.\n\n${formatJson(result)}`, result);
        return;
      }

      if (parsed.verb === "clear") {
        const reason = optionString(parsed.options, "reason") ?? "demoted";
        if (!["completed", "demoted"].includes(reason)) throw new Error("--reason must be completed or demoted");
        const loop = readLoopState(ctx.cwd);
        const active = loop.active_candidate_set;
        if (!active) throw new Error("no active candidate set to clear");
        const store = readWorkItems(ctx.cwd);
        const nextWork = bumpWorkItemsStore(cloneWorkItems(store));
        let changedWork = false;

        for (const id of active.work_item_ids) {
          const item = requireCandidateItem(nextWork, id);
          if (reason === "completed") {
            if (item.status !== "done") throw new Error(`${id} is ${item.status}; completed clear requires all WIs done`);
          } else {
            item.status = "ready";
            item.promotion = { candidate_branch: null, candidate_commit: null, status: "not_ready" };
            item.revision += 1;
            changedWork = true;
          }
        }

        const nextLoop = {
          ...loop,
          revision: loop.revision + 1,
          updated_at: nowIso(),
          active_candidate_set: null,
          mode: reason === "completed" ? "DONE" : "IMPLEMENT",
          next_action: {
            owner: "orchestrator",
            type: reason === "completed" ? "activate_next_candidate" : "resume_rework",
            target: null
          }
        };

        const writes: StateTransaction["writes"] = [
          { path: relativeStatePath("loop"), expected_revision: loop.revision, content: nextLoop }
        ];
        if (changedWork) writes.push({ path: relativeStatePath("workItems"), expected_revision: store.revision, content: nextWork });

        const result = await commitTx(pi, ctx.cwd, {
          request_id: requestId,
          message: `aa-candidate clear ${active.id} ${reason}`,
          writes,
          deletes: []
        });
        refreshAtelierWidgets(ctx);
        postText(pi, `Cleared ${active.id} (${reason}).\n\n${formatJson(result)}`, result);
        return;
      }

      throw new Error("usage: /aa-candidate enqueue|activate|clear ... --request-id <id>");
    }
  });
}

function requireCandidateItem(store: WorkItemsStore, id: string) {
  const item = store.items.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`${id} not found`);
  return item;
}

function nextCandidateId(existing: CandidateSet[]): string {
  const max = existing.reduce((highest, candidate) => {
    const match = /^CS-(\d+)$/.exec(candidate.id);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `CS-${String(max + 1).padStart(3, "0")}`;
}

function ensureNotQueued(loop: ReturnType<typeof readLoopState>, ids: string[]): void {
  const activeIds = new Set(loop.active_candidate_set?.work_item_ids ?? []);
  for (const id of ids) {
    if (activeIds.has(id)) throw new Error(`${id} is already in active candidate set`);
    const queued = loop.candidate_queue.find((candidate) => candidate.work_item_ids.includes(id));
    if (queued) throw new Error(`${id} is already queued in ${queued.id}`);
  }
}

function txWrites(loopRevision: number, loop: unknown, workRevision: number, work: unknown): StateTransaction["writes"] {
  return [
    { path: relativeStatePath("loop"), expected_revision: loopRevision, content: loop },
    { path: relativeStatePath("workItems"), expected_revision: workRevision, content: work }
  ];
}
