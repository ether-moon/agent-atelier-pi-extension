export type WorkItemStatus =
  | "pending"
  | "ready"
  | "implementing"
  | "candidate_queued"
  | "candidate_validating"
  | "reviewing"
  | "blocked_on_human_gate"
  | "done";

export type WorkItemComplexity = null | "simple" | "complex";

export interface Promotion {
  candidate_branch: string | null;
  candidate_commit: string | null;
  status: string;
}

export interface WorkItem {
  id: string;
  revision: number;
  behavior_spec_revision: number;
  title: string;
  why_now: string;
  non_goals: string[];
  decision_rationale: string[];
  relevant_constraints: string[];
  success_metric_refs: string[];
  owner_role: string;
  owner_session_id: string | null;
  depends_on: string[];
  complexity: WorkItemComplexity;
  behaviors: string[];
  input_artifacts: string[];
  owned_paths: string[];
  verify: string[];
  status: WorkItemStatus;
  blocked_by_gate: string | null;
  resume_target: string | null;
  first_claimed_at: string | null;
  handoff_count: number;
  attempt_count: number;
  last_heartbeat_at: string | null;
  lease_expires_at: string | null;
  stale_requeue_count: number;
  last_requeue_reason?: string | null;
  last_attempt_ref: string | null;
  last_finding_fingerprint: string | null;
  promotion: Promotion;
  completion: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface WorkItemsStore {
  revision: number;
  updated_at: string;
  items: WorkItem[];
}

export interface CandidateSet {
  id: string;
  work_item_ids: string[];
  branch: string;
  commit: string;
  type: "single" | "batch";
  activated_at: string | null;
}

export interface LoopState {
  revision: number;
  updated_at: string;
  mode: string;
  active_spec: string;
  active_spec_revision: number;
  open_gates: string[];
  active_candidate_set: CandidateSet | null;
  candidate_queue: CandidateSet[];
  team_name: string | null;
  next_action: {
    owner: string;
    type: string;
    target: string | null;
  };
  [key: string]: unknown;
}

export interface WatchdogJobs {
  revision: number;
  updated_at: string;
  defaults: Record<string, number>;
  budgets: Record<string, number>;
  open_alerts: unknown[];
  last_tick_at: string;
  monitors?: Record<string, MonitorRecord>;
  [key: string]: unknown;
}

export interface MonitorRecord {
  name: string;
  pid: number;
  status: "running" | "stopped" | "dead";
  started_at: string;
  stopped_at?: string | null;
  interval_ms: number;
  last_event_at?: string | null;
}

export interface HumanGate {
  id: string;
  created_at: string | null;
  state_revision: number | null;
  triggered_by: string | null;
  state: "open" | "resolved";
  question: string | null;
  why_now: string | null;
  context: string | null;
  gate_criteria: Record<string, unknown>;
  options: string[];
  recommended_option: string | null;
  blocking: boolean;
  blocked_work_items: string[];
  unblocked_work_items: string[];
  resume_target: string | null;
  default_if_no_response: string;
  linked_escalations: string[];
  resolution: {
    resolved_at: string | null;
    chosen_option: string | null;
    user_notes: string | null;
    follow_up_actions: string[];
  };
  [key: string]: unknown;
}

export interface StateTransaction {
  request_id?: string;
  message?: string;
  writes: Array<{
    path: string;
    expected_revision: number | null;
    content: unknown;
  }>;
  deletes: string[];
}
