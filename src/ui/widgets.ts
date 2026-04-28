import type { LoopState, WatchdogJobs, WorkItem, WorkItemsStore } from "../lib/types.js";

export function renderStatusWidget(input: {
  loop: LoopState | null;
  workItems: WorkItemsStore | null;
  watchdog: WatchdogJobs | null;
  openGateCount: number;
}): string[] {
  const { loop, workItems, watchdog, openGateCount } = input;
  if (!loop || !workItems || !watchdog) {
    return ["agent-atelier: not initialized", "Run /aa-init to bootstrap .agent-atelier state."];
  }

  const counts = new Map<string, number>();
  for (const item of workItems.items) counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
  const statusText =
    workItems.items.length === 0
      ? "no work items"
      : Array.from(counts.entries())
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([status, count]) => `${status}:${count}`)
          .join(" ");

  const activeCandidate = loop.active_candidate_set
    ? `${loop.active_candidate_set.id} (${loop.active_candidate_set.work_item_ids.join(",")})`
    : "none";
  const ACTIVE_WI_LIMIT = 5;
  const activeWiAll = workItems.items.filter((item) =>
    ["ready", "implementing", "candidate_validating", "reviewing", "blocked_on_human_gate"].includes(item.status)
  );
  const activeWis = activeWiAll.slice(0, ACTIVE_WI_LIMIT).map(formatActiveWi);
  const hiddenActiveWis = Math.max(0, activeWiAll.length - ACTIVE_WI_LIMIT);
  const monitors = watchdog.monitors ? Object.values(watchdog.monitors) : [];
  const monitorText =
    monitors.length === 0 ? "none" : monitors.map((monitor) => `${monitor.name}:${monitor.status}#${monitor.pid}`).join(" ");

  const lines = [
    `agent-atelier mode: ${loop.mode}`,
    `work: ${statusText}`,
    `candidate: active=${activeCandidate} queued=${loop.candidate_queue.length}`,
    `gates: ${openGateCount} open`,
    `watchdog: last_tick=${watchdog.last_tick_at ?? "never"} alerts=${watchdog.open_alerts.length}`,
    `monitors: ${monitorText}`
  ];
  if (activeWis.length > 0) lines.push(...activeWis);
  if (hiddenActiveWis > 0) lines.push(`... and ${hiddenActiveWis} more active WI${hiddenActiveWis === 1 ? "" : "s"}`);
  return lines;
}

export function renderWorkItems(store: WorkItemsStore): string {
  if (store.items.length === 0) return "No work items.";
  return store.items
    .map((item) => `${item.id} [${item.status}] ${item.title || "(untitled)"} owner=${item.owner_role}`)
    .join("\n");
}

function formatActiveWi(item: WorkItem): string {
  const lease = item.lease_expires_at ? ` lease=${item.lease_expires_at}` : "";
  return `${item.id}: ${item.status} ${item.title || "(untitled)"}${lease}`;
}
