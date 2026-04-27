import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { optionBool, parseArgs } from "../lib/argparse.js";
import { formatJson, postText } from "../lib/output.js";
import { relativeStatePath, repoRoot, stateExists, validationDir } from "../lib/paths.js";
import { nowIso } from "../lib/time.js";
import type { LoopState, WorkItem, WorkItemsStore } from "../lib/types.js";
import { readLoopState } from "../state/loopState.js";
import { commitTx } from "../state/stateCommit.js";
import { buildVrmPrompt } from "../state/vrmPrompt.js";
import { bumpWorkItemsStore, cloneWorkItems, normalizeWorkItem, readWorkItems } from "../state/workItems.js";
import { refreshAtelierWidgets } from "../ui/refresh.js";
import { spawnMonitorProcesses, MONITOR_NAMES } from "./monitors.js";
import { discoverAgents } from "../subagents/agents.js";
import { getFinalOutput, runSingleAgent } from "../subagents/spawn.js";

export interface RunState {
  orchestratorActive: boolean;
  coldResumeDone: boolean;
}

export function registerRunCommand(pi: ExtensionAPI, state: RunState): void {
  pi.registerCommand("aa-run", {
    description: "Start or continue one agent-atelier orchestration cycle",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      state.orchestratorActive = true;

      const root = repoRoot(ctx.cwd);
      if (!stateExists(root)) {
        postText(pi, "agent-atelier is not initialized. Run /aa-init first.");
        return;
      }

      if (!optionBool(parsed.options, "no-monitors")) {
        await spawnMonitorProcesses(pi, ctx.cwd, `aa-run-monitors-${Date.now()}`, [...MONITOR_NAMES], 15_000);
      }

      if (!state.coldResumeDone) {
        await coldResumeSweep(pi, ctx);
        state.coldResumeDone = true;
      }

      const action = await runOneCycle(pi, ctx);
      refreshAtelierWidgets(ctx);
      postText(pi, action);
    }
  });
}

async function runOneCycle(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<string> {
  const loop = readLoopState(ctx.cwd);
  const work = readWorkItems(ctx.cwd);

  if (loop.active_candidate_set) {
    return validateOrReviewActiveCandidate(pi, ctx, loop, work);
  }

  if (loop.candidate_queue.length > 0) {
    await activateNextCandidate(pi, ctx, loop, work);
    return "Activated the next queued candidate set. Run /aa-run again to validate it.";
  }

  const reviewing = work.items.find((item) => item.status === "reviewing");
  if (reviewing) return reviewStandaloneItem(pi, ctx, reviewing);

  const ready = work.items.find((item) => item.status === "ready");
  if (ready) return implementReadyItem(pi, ctx, ready);

  const unplanned = work.items.find((item) => item.status === "pending" && item.complexity == null);
  if (unplanned) return planPendingItem(pi, ctx, unplanned);

  if (work.items.length === 0) {
    return "No work items exist yet. Ask PM/Architect to create the first WI, or add one with /aa-wi upsert.";
  }

  return "No runnable work found. Current state is stable or waiting on a gate/candidate/review.";
}

async function coldResumeSweep(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
  const store = readWorkItems(ctx.cwd);
  const stranded = store.items.filter((item) => item.status === "implementing");
  if (stranded.length === 0) return;

  const next = bumpWorkItemsStore(cloneWorkItems(store));
  for (const item of next.items) {
    if (item.status !== "implementing") continue;
    item.status = "ready";
    item.owner_session_id = null;
    item.last_heartbeat_at = null;
    item.lease_expires_at = null;
    item.last_requeue_reason = "cold-resume: owner session unavailable";
    item.revision += 1;
  }

  await commitTx(pi, ctx.cwd, {
    request_id: `aa-run-cold-resume-${Date.now()}`,
    message: "aa-run cold resume sweep",
    writes: [{ path: relativeStatePath("workItems"), expected_revision: store.revision, content: next }],
    deletes: []
  });
}

async function planPendingItem(pi: ExtensionAPI, ctx: ExtensionCommandContext, item: WorkItem): Promise<string> {
  const output = await runBundledAgent(
    ctx,
    "architect",
    [
      `Assess and normalize this pending work item as JSON.`,
      `Return either a single work item object or {"items":[...]}.`,
      `The item must include id, title, status, complexity ("simple" or "complex"), owned_paths, verify, and behaviors.`,
      formatJson(item)
    ].join("\n\n")
  );
  const parsed = extractJson(output);
  if (!parsed) {
    return `Architect completed planning for ${item.id}, but no JSON payload was detected. Output:\n\n${output}`;
  }

  const store = readWorkItems(ctx.cwd);
  const next = bumpWorkItemsStore(cloneWorkItems(store));
  const payloads = Array.isArray((parsed as { items?: unknown[] }).items) ? ((parsed as { items: Record<string, unknown>[] }).items) : [parsed as Record<string, unknown>];
  for (const payload of payloads) {
    const index = next.items.findIndex((candidate) => candidate.id === payload.id);
    const existing = index === -1 ? undefined : next.items[index];
    const normalized = normalizeWorkItem({ ...payload, status: payload.status ?? "ready" }, existing);
    if (index === -1) next.items.push(normalized);
    else next.items[index] = normalized;
  }
  await commitTx(pi, ctx.cwd, {
    request_id: `aa-run-plan-${Date.now()}`,
    message: `aa-run architect plan ${item.id}`,
    writes: [{ path: relativeStatePath("workItems"), expected_revision: store.revision, content: next }],
    deletes: []
  });
  return `Architect planned ${item.id}; normalized work item state was committed.`;
}

async function implementReadyItem(pi: ExtensionAPI, ctx: ExtensionCommandContext, item: WorkItem): Promise<string> {
  const ownerSession = `aa-run-${item.id}-${Date.now()}`;
  await updateWorkItem(pi, ctx.cwd, item.id, (wi) => {
    wi.status = "implementing";
    wi.owner_session_id = ownerSession;
    wi.first_claimed_at ??= nowIso();
    wi.last_heartbeat_at = nowIso();
    wi.lease_expires_at = new Date(Date.now() + 90 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  }, `aa-run claim ${item.id}`);

  let planText: string | null = null;
  if (item.complexity === "complex") {
    const plan = await runBundledAgent(ctx, "builder-plan", buildBuilderTask(item, null));
    planText = plan.trim();
    if (ctx.hasUI) {
      const approved = await ctx.ui.confirm(`Approve ${item.id} plan?`, planText || "(empty plan)");
      if (!approved) {
        const refinement = await ctx.ui.editor("Plan feedback", planText);
        await updateWorkItem(pi, ctx.cwd, item.id, (wi) => {
          wi.status = "ready";
          wi.owner_session_id = null;
          wi.last_heartbeat_at = null;
          wi.lease_expires_at = null;
          wi.plan_feedback = refinement ?? "plan rejected";
        }, `aa-run reject plan ${item.id}`);
        return `Plan for ${item.id} was rejected and the WI returned to ready.`;
      }
    }
    await updateWorkItem(pi, ctx.cwd, item.id, (wi) => {
      wi.approved_plan = planText;
      wi.plan_approved_at = nowIso();
    }, `aa-run approve plan ${item.id}`);
  }

  const builderOutput = await runBundledAgent(ctx, "builder", buildBuilderTask(item, planText));
  if (!builderOutput.trim()) {
    await requeueAfterFailure(pi, ctx.cwd, item.id, "builder produced no output");
    return `Builder produced no output for ${item.id}; WI was requeued.`;
  }

  const { branch, commit } = currentGitRef(ctx.cwd);
  await enqueueAndActivateCandidate(pi, ctx.cwd, item.id, branch, commit);
  return `Builder completed ${item.id}; candidate was queued and activated at ${branch}@${commit}. Run /aa-run again to validate.`;
}

async function validateOrReviewActiveCandidate(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  loop: LoopState,
  work: WorkItemsStore
): Promise<string> {
  const active = loop.active_candidate_set;
  if (!active) return "No active candidate set.";

  const activeItems = active.work_item_ids.map((id) => work.items.find((item) => item.id === id)).filter((item): item is WorkItem => Boolean(item));
  if (activeItems.length === 0) return `${active.id} references no existing WIs.`;

  if (activeItems.every((item) => item.status === "reviewing")) {
    return reviewActiveCandidate(pi, ctx, activeItems);
  }

  const vrmInput = await buildVrmPrompt(pi, ctx.cwd);
  const vrmOutput = await runBundledAgent(
    ctx,
    "vrm",
    [
      `Validate candidate set ${active.id}.`,
      `Branch: ${active.branch}`,
      `Commit: ${active.commit}`,
      `Work items: ${active.work_item_ids.join(", ")}`,
      `Evidence input:\n${formatJson(vrmInput)}`,
      `Return objective validation findings only.`
    ].join("\n")
  );
  const passed = vrmOutput.trim().length > 0;
  const runId = `RUN-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z")}`;
  const manifestPath = writeValidationManifest(ctx.cwd, runId, active, activeItems, passed ? "passed" : "failed", vrmOutput);

  if (!passed) {
    await demoteActiveCandidate(pi, ctx.cwd, active.work_item_ids, `validation failed: ${manifestPath}`);
    return `VRM failed ${active.id}; candidate was demoted and WIs returned to ready.`;
  }

  const fastTrack = activeItems.every((item) => item.complexity === "simple") && diffStatLines(ctx.cwd) <= 30 && !hasSensitiveOwnedPath(activeItems);
  if (fastTrack) {
    await completeActiveCandidate(pi, ctx.cwd, activeItems, manifestPath, "fast-track validation");
    return `VRM passed ${active.id}; simple candidate fast-tracked to done.`;
  }

  await markCandidateReviewing(pi, ctx.cwd, active.work_item_ids, manifestPath);
  return `VRM passed ${active.id}; candidate moved to review. Run /aa-run again for QA/UX review.`;
}

async function reviewStandaloneItem(pi: ExtensionAPI, ctx: ExtensionCommandContext, item: WorkItem): Promise<string> {
  const qa = await runBundledAgent(ctx, "qa-reviewer", `Review ${item.id} for correctness.\n\n${formatJson(item)}`);
  const ux = await runBundledAgent(ctx, "ux-reviewer", `Review ${item.id} for UX and product fit.\n\n${formatJson(item)}`);
  await updateWorkItem(pi, ctx.cwd, item.id, (wi) => {
    wi.status = "done";
    wi.completion = {
      completed_at: nowIso(),
      review: { qa: qa.slice(0, 2000), ux: ux.slice(0, 2000) }
    };
  }, `aa-run review complete ${item.id}`);
  return `Reviewed and completed ${item.id}.`;
}

async function reviewActiveCandidate(pi: ExtensionAPI, ctx: ExtensionCommandContext, items: WorkItem[]): Promise<string> {
  const qa = await runBundledAgent(ctx, "qa-reviewer", `Review active candidate WIs for correctness.\n\n${formatJson(items)}`);
  const ux = await runBundledAgent(ctx, "ux-reviewer", `Review active candidate WIs for UX and product fit.\n\n${formatJson(items)}`);
  await completeActiveCandidate(pi, ctx.cwd, items, null, `reviewed: qa=${qa.slice(0, 500)} ux=${ux.slice(0, 500)}`);
  return `QA/UX review completed; ${items.map((item) => item.id).join(", ")} marked done.`;
}

async function activateNextCandidate(pi: ExtensionAPI, ctx: ExtensionCommandContext, loop: LoopState, work: WorkItemsStore): Promise<void> {
  const [candidate, ...queue] = loop.candidate_queue;
  if (!candidate) return;
  const nextWork = bumpWorkItemsStore(cloneWorkItems(work));
  for (const id of candidate.work_item_ids) {
    const item = nextWork.items.find((wi) => wi.id === id);
    if (!item) continue;
    item.status = "candidate_validating";
    item.promotion.status = "candidate_validating";
    item.revision += 1;
  }
  await commitTx(pi, ctx.cwd, {
    request_id: `aa-run-activate-${Date.now()}`,
    message: `aa-run activate ${candidate.id}`,
    writes: [
      {
        path: relativeStatePath("loop"),
        expected_revision: loop.revision,
        content: {
          ...loop,
          revision: loop.revision + 1,
          updated_at: nowIso(),
          mode: "CANDIDATE_VALIDATE",
          active_candidate_set: { ...candidate, activated_at: nowIso() },
          candidate_queue: queue,
          next_action: { owner: "vrm", type: "validate_candidate", target: candidate.id }
        }
      },
      { path: relativeStatePath("workItems"), expected_revision: work.revision, content: nextWork }
    ],
    deletes: []
  });
}

async function enqueueAndActivateCandidate(pi: ExtensionAPI, cwd: string, id: string, branch: string, commit: string): Promise<void> {
  const loop = readLoopState(cwd);
  const work = readWorkItems(cwd);
  const nextWork = bumpWorkItemsStore(cloneWorkItems(work));
  const item = nextWork.items.find((wi) => wi.id === id);
  if (!item) throw new Error(`${id} not found`);
  const candidate = {
    id: nextCandidateId(loop),
    work_item_ids: [id],
    branch,
    commit,
    type: "single" as const,
    activated_at: nowIso()
  };
  item.status = "candidate_validating";
  item.owner_session_id = null;
  item.last_heartbeat_at = null;
  item.lease_expires_at = null;
  item.promotion = { candidate_branch: branch, candidate_commit: commit, status: "candidate_validating" };
  item.revision += 1;
  await commitTx(pi, cwd, {
    request_id: `aa-run-candidate-${Date.now()}`,
    message: `aa-run candidate ${id}`,
    writes: [
      {
        path: relativeStatePath("loop"),
        expected_revision: loop.revision,
        content: {
          ...loop,
          revision: loop.revision + 1,
          updated_at: nowIso(),
          mode: "CANDIDATE_VALIDATE",
          active_candidate_set: candidate,
          next_action: { owner: "vrm", type: "validate_candidate", target: candidate.id }
        }
      },
      { path: relativeStatePath("workItems"), expected_revision: work.revision, content: nextWork }
    ],
    deletes: []
  });
}

async function markCandidateReviewing(pi: ExtensionAPI, cwd: string, ids: string[], manifestPath: string): Promise<void> {
  await updateWorkItems(pi, cwd, ids, (item) => {
    item.status = "reviewing";
    item.promotion.status = "reviewing";
    item.validation_manifest = manifestPath;
  }, "aa-run mark reviewing");
}

async function completeActiveCandidate(
  pi: ExtensionAPI,
  cwd: string,
  items: WorkItem[],
  manifestPath: string | null,
  summary: string
): Promise<void> {
  const loop = readLoopState(cwd);
  const work = readWorkItems(cwd);
  const nextWork = bumpWorkItemsStore(cloneWorkItems(work));
  for (const source of items) {
    const item = nextWork.items.find((wi) => wi.id === source.id);
    if (!item) continue;
    item.status = "done";
    item.owner_session_id = null;
    item.last_heartbeat_at = null;
    item.lease_expires_at = null;
    item.completion = {
      completed_at: nowIso(),
      validation_manifest: manifestPath,
      summary
    };
    item.revision += 1;
  }
  await commitTx(pi, cwd, {
    request_id: `aa-run-complete-${Date.now()}`,
    message: "aa-run complete candidate",
    writes: [
      { path: relativeStatePath("workItems"), expected_revision: work.revision, content: nextWork },
      {
        path: relativeStatePath("loop"),
        expected_revision: loop.revision,
        content: {
          ...loop,
          revision: loop.revision + 1,
          updated_at: nowIso(),
          active_candidate_set: null,
          mode: loop.candidate_queue.length ? "IMPLEMENT" : "DONE",
          next_action: { owner: "orchestrator", type: "activate_next_candidate", target: null }
        }
      }
    ],
    deletes: []
  });
}

async function demoteActiveCandidate(pi: ExtensionAPI, cwd: string, ids: string[], reason: string): Promise<void> {
  const loop = readLoopState(cwd);
  const work = readWorkItems(cwd);
  const nextWork = bumpWorkItemsStore(cloneWorkItems(work));
  for (const id of ids) {
    const item = nextWork.items.find((wi) => wi.id === id);
    if (!item) continue;
    item.status = "ready";
    item.promotion = { candidate_branch: null, candidate_commit: null, status: "not_ready" };
    item.last_requeue_reason = reason;
    item.revision += 1;
  }
  await commitTx(pi, cwd, {
    request_id: `aa-run-demote-${Date.now()}`,
    message: "aa-run demote candidate",
    writes: [
      { path: relativeStatePath("workItems"), expected_revision: work.revision, content: nextWork },
      {
        path: relativeStatePath("loop"),
        expected_revision: loop.revision,
        content: {
          ...loop,
          revision: loop.revision + 1,
          updated_at: nowIso(),
          active_candidate_set: null,
          mode: "IMPLEMENT",
          next_action: { owner: "orchestrator", type: "resume_rework", target: null }
        }
      }
    ],
    deletes: []
  });
}

async function requeueAfterFailure(pi: ExtensionAPI, cwd: string, id: string, reason: string): Promise<void> {
  await updateWorkItem(pi, cwd, id, (wi) => {
    wi.status = "ready";
    wi.last_requeue_reason = reason;
    wi.owner_session_id = null;
    wi.last_heartbeat_at = null;
    wi.lease_expires_at = null;
  }, `aa-run requeue ${id}`);
}

async function updateWorkItem(
  pi: ExtensionAPI,
  cwd: string,
  id: string,
  mutate: (item: WorkItem) => void,
  message: string
): Promise<void> {
  await updateWorkItems(pi, cwd, [id], mutate, message);
}

async function updateWorkItems(
  pi: ExtensionAPI,
  cwd: string,
  ids: string[],
  mutate: (item: WorkItem) => void,
  message: string
): Promise<void> {
  const store = readWorkItems(cwd);
  const next = bumpWorkItemsStore(cloneWorkItems(store));
  for (const id of ids) {
    const item = next.items.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`${id} not found`);
    mutate(item);
    item.revision += 1;
  }
  await commitTx(pi, cwd, {
    request_id: `${message.replace(/\s+/g, "-")}-${Date.now()}`,
    message,
    writes: [{ path: relativeStatePath("workItems"), expected_revision: store.revision, content: next }],
    deletes: []
  });
}

async function runBundledAgent(ctx: ExtensionCommandContext, agentName: string, task: string): Promise<string> {
  const discovery = discoverAgents();
  const result = await runSingleAgent(
    ctx.cwd,
    discovery.agents,
    discovery.agentsDir,
    agentName,
    task,
    undefined,
    undefined,
    ctx.signal,
    undefined,
    (results) => ({ mode: "single", agentsDir: discovery.agentsDir, results })
  );
  if (result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted") {
    throw new Error(result.errorMessage || result.stderr || getFinalOutput(result.messages) || `${agentName} failed`);
  }
  return getFinalOutput(result.messages);
}

function buildBuilderTask(item: WorkItem, plan: string | null): string {
  return [
    `Implement work item ${item.id}: ${item.title}`,
    `Owned paths: ${item.owned_paths.join(", ") || "(unspecified)"}`,
    `Verification: ${item.verify.join(", ") || "(unspecified)"}`,
    `Behaviors: ${item.behaviors.join(", ") || "(unspecified)"}`,
    plan ? `Approved plan:\n${plan}` : "",
    `When done, summarize changed files and verification performed.`
  ]
    .filter(Boolean)
    .join("\n\n");
}

function writeValidationManifest(
  cwd: string,
  runId: string,
  active: NonNullable<LoopState["active_candidate_set"]>,
  items: WorkItem[],
  status: "passed" | "failed",
  output: string
): string {
  const root = repoRoot(cwd);
  const dir = path.join(validationDir(root), runId);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id: runId,
    candidate_set_id: active.id,
    work_item_ids: active.work_item_ids,
    candidate_branch: active.branch,
    candidate_commit: active.commit,
    started_at: nowIso(),
    finished_at: nowIso(),
    status,
    checks: [{ name: "vrm", status }],
    evidence_refs: [],
    work_item_titles: items.map((item) => item.title),
    vrm_output: output
  };
  const relPath = `.agent-atelier/validation/${runId}/manifest.json`;
  fs.writeFileSync(path.join(root, relPath), `${JSON.stringify(manifest, null, 2)}\n`);
  return relPath;
}

function extractJson(text: string): unknown | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

function nextCandidateId(loop: LoopState): string {
  const candidates = [...(loop.active_candidate_set ? [loop.active_candidate_set] : []), ...loop.candidate_queue];
  const max = candidates.reduce((highest, candidate) => {
    const match = /^CS-(\d+)$/.exec(candidate.id);
    return match ? Math.max(highest, Number(match[1])) : highest;
  }, 0);
  return `CS-${String(max + 1).padStart(3, "0")}`;
}

function currentGitRef(cwd: string): { branch: string; commit: string } {
  return {
    branch: git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD",
    commit: git(cwd, ["rev-parse", "HEAD"]) || "unknown"
  };
}

function diffStatLines(cwd: string): number {
  const output = git(cwd, ["diff", "--stat", "HEAD"], false);
  const match = /(\d+)\s+insertion|\s(\d+)\s+deletion/.exec(output);
  if (!match) return 0;
  return output
    .split("\n")
    .map((line) => [...line.matchAll(/(\d+)\s+(insertion|deletion)/g)].reduce((sum, part) => sum + Number(part[1]), 0))
    .reduce((sum, value) => sum + value, 0);
}

function hasSensitiveOwnedPath(items: WorkItem[]): boolean {
  return items.some((item) => item.owned_paths.some((ownedPath) => /auth|payment|schema-migration|public-api/i.test(ownedPath)));
}

function git(cwd: string, args: string[], throwOnError = true): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", throwOnError ? "pipe" : "ignore"]
    }).trim();
  } catch (error) {
    if (throwOnError) throw error;
    return "";
  }
}
