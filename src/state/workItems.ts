import { repoRoot, workItemsPath } from "../lib/paths.js";
import type { WorkItem, WorkItemsStore, WorkItemStatus } from "../lib/types.js";
import { nowIso } from "../lib/time.js";
import { readJsonFile, tryReadJsonFile } from "./readJson.js";

export const VALID_STATUSES: WorkItemStatus[] = [
  "pending",
  "ready",
  "implementing",
  "candidate_queued",
  "candidate_validating",
  "reviewing",
  "blocked_on_human_gate",
  "done"
];

const ARRAY_FIELDS = [
  "non_goals",
  "decision_rationale",
  "relevant_constraints",
  "success_metric_refs",
  "depends_on",
  "behaviors",
  "input_artifacts",
  "owned_paths",
  "verify"
] as const;

export const DEFAULT_WORK_ITEM: WorkItem = {
  id: "",
  revision: 0,
  behavior_spec_revision: 1,
  title: "",
  why_now: "",
  non_goals: [],
  decision_rationale: [],
  relevant_constraints: [],
  success_metric_refs: [],
  owner_role: "builder",
  owner_session_id: null,
  depends_on: [],
  complexity: null,
  behaviors: [],
  input_artifacts: [],
  owned_paths: [],
  verify: [],
  status: "pending",
  blocked_by_gate: null,
  resume_target: null,
  first_claimed_at: null,
  handoff_count: 0,
  attempt_count: 0,
  last_heartbeat_at: null,
  lease_expires_at: null,
  stale_requeue_count: 0,
  last_attempt_ref: null,
  last_finding_fingerprint: null,
  promotion: {
    candidate_branch: null,
    candidate_commit: null,
    status: "not_ready"
  },
  completion: null
};

export function readWorkItems(cwd: string): WorkItemsStore {
  return readJsonFile<WorkItemsStore>(workItemsPath(repoRoot(cwd)));
}

export function tryReadWorkItems(cwd: string): WorkItemsStore | null {
  return tryReadJsonFile<WorkItemsStore>(workItemsPath(repoRoot(cwd)));
}

export function findWorkItem(store: WorkItemsStore, id: string): WorkItem | undefined {
  return store.items.find((item) => item.id === id);
}

export function normalizeWorkItem(payload: Record<string, unknown>, existing?: WorkItem): WorkItem {
  const merged = {
    ...DEFAULT_WORK_ITEM,
    ...(existing ?? {}),
    ...payload
  } as WorkItem;

  if (!merged.id || typeof merged.id !== "string") {
    throw new Error("work item id is required");
  }

  for (const field of ARRAY_FIELDS) {
    const value = merged[field];
    if (value == null) {
      (merged as unknown as Record<string, unknown>)[field] = [];
    } else if (!Array.isArray(value)) {
      throw new Error(`${field} must be an array`);
    }
  }

  if (!VALID_STATUSES.includes(merged.status)) {
    throw new Error(`invalid status: ${merged.status}`);
  }

  if (![null, "simple", "complex"].includes(merged.complexity)) {
    throw new Error(`invalid complexity: ${String(merged.complexity)}`);
  }

  if (existing?.depends_on?.length && JSON.stringify(existing.depends_on) !== JSON.stringify(merged.depends_on)) {
    throw new Error("depends_on is immutable after initial upsert");
  }

  merged.promotion = {
    candidate_branch: merged.promotion?.candidate_branch ?? null,
    candidate_commit: merged.promotion?.candidate_commit ?? null,
    status: merged.promotion?.status ?? "not_ready"
  };

  if (merged.status !== "implementing") {
    merged.owner_session_id = null;
    merged.last_heartbeat_at = null;
    merged.lease_expires_at = null;
  }

  if (merged.status !== "blocked_on_human_gate" && !Object.hasOwn(payload, "blocked_by_gate")) {
    merged.blocked_by_gate = null;
  }

  merged.revision = (existing?.revision ?? 0) + 1;
  return merged;
}

export function cloneWorkItems(store: WorkItemsStore): WorkItemsStore {
  return JSON.parse(JSON.stringify(store)) as WorkItemsStore;
}

export function bumpWorkItemsStore(store: WorkItemsStore): WorkItemsStore {
  return {
    ...store,
    revision: store.revision + 1,
    updated_at: nowIso()
  };
}
