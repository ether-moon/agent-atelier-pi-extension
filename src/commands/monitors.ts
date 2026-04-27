import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { optionString, parseArgs, requireRequestId } from "../lib/argparse.js";
import { formatJson, postText } from "../lib/output.js";
import { assetPath, relativeStatePath, repoRoot } from "../lib/paths.js";
import { nowIso } from "../lib/time.js";
import type { MonitorRecord, WatchdogJobs } from "../lib/types.js";
import { commitTx } from "../state/stateCommit.js";
import { readWatchdogJobs, tryReadWatchdogJobs } from "../state/watchdogJobs.js";
import { refreshAtelierWidgets } from "../ui/refresh.js";

export const MONITOR_NAMES = ["heartbeat-watch", "gate-watch", "event-tail", "ci-status", "branch-divergence"] as const;
export type MonitorName = (typeof MONITOR_NAMES)[number];

export function registerMonitorsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("aa-monitors", {
    description: "Spawn, show, or stop agent-atelier monitor processes",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      const verb = parsed.verb || "status";

      if (verb === "status") {
        const jobs = readWatchdogJobs(ctx.cwd);
        const monitors = reconcileMonitorRecords(jobs);
        postText(pi, formatMonitorStatus(monitors), { monitors });
        refreshAtelierWidgets(ctx);
        return;
      }

      const requestId = requireRequestId(parsed.options);
      if (verb === "spawn") {
        const requested = parsed.positionals[0] ?? optionString(parsed.options, "name") ?? "all";
        const names = requested === "all" ? [...MONITOR_NAMES] : [assertMonitorName(requested)];
        const intervalMs = Number(optionString(parsed.options, "interval-ms") ?? 15_000);
        const result = await spawnMonitorProcesses(pi, ctx.cwd, requestId, names, intervalMs);
        postText(pi, `Monitor processes running: ${names.join(", ")}\n\n${formatJson(result)}`, result);
        refreshAtelierWidgets(ctx);
        return;
      }

      if (verb === "stop") {
        const requested = parsed.positionals[0] ?? optionString(parsed.options, "name") ?? "all";
        const jobs = readWatchdogJobs(ctx.cwd);
        const monitors = { ...(jobs.monitors ?? {}) };
        const names = requested === "all" ? Object.keys(monitors) : [assertMonitorName(requested)];
        for (const name of names) {
          const record = monitors[name];
          if (!record) continue;
          killPid(record.pid);
          monitors[name] = { ...record, status: "stopped", stopped_at: nowIso() };
        }
        const result = await writeMonitors(pi, ctx.cwd, requestId, jobs, monitors, "aa-monitors stop");
        postText(pi, `Stopped monitors: ${names.join(", ") || "none"}\n\n${formatJson(result)}`, result);
        refreshAtelierWidgets(ctx);
        return;
      }

      throw new Error("usage: /aa-monitors spawn|status|stop [all|heartbeat-watch|gate-watch|event-tail|ci-status|branch-divergence]");
    }
  });
}

export function stopAllKnownMonitors(cwd: string): void {
  const jobs = tryReadWatchdogJobs(cwd);
  if (!jobs?.monitors) return;
  for (const record of Object.values(jobs.monitors)) killPid(record.pid);
}

export async function spawnMonitorProcesses(
  pi: ExtensionAPI,
  cwd: string,
  requestId: string,
  names: MonitorName[],
  intervalMs: number
): Promise<Record<string, unknown>> {
  const jobs = readWatchdogJobs(cwd);
  const root = repoRoot(cwd);
  const monitors = { ...(jobs.monitors ?? {}) };

  for (const name of names) {
    const existing = monitors[name];
    if (existing && isPidAlive(existing.pid)) {
      monitors[name] = { ...existing, status: "running" };
      continue;
    }
    const child = spawn(process.execPath, [assetPath("src", "monitors", "worker.mjs"), name, root, String(intervalMs)], {
      cwd: root,
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    monitors[name] = {
      name,
      pid: child.pid ?? -1,
      status: "running",
      started_at: nowIso(),
      stopped_at: null,
      interval_ms: intervalMs,
      last_event_at: null
    };
  }

  return writeMonitors(pi, cwd, requestId, jobs, monitors, "aa-monitors spawn");
}

function reconcileMonitorRecords(jobs: WatchdogJobs): Record<string, MonitorRecord> {
  const monitors = { ...(jobs.monitors ?? {}) };
  for (const [name, record] of Object.entries(monitors)) {
    monitors[name] = { ...record, status: isPidAlive(record.pid) ? "running" : record.status === "stopped" ? "stopped" : "dead" };
  }
  return monitors;
}

async function writeMonitors(
  pi: ExtensionAPI,
  cwd: string,
  requestId: string,
  previous: WatchdogJobs,
  monitors: Record<string, MonitorRecord>,
  message: string
): Promise<Record<string, unknown>> {
  const next = {
    ...previous,
    revision: previous.revision + 1,
    updated_at: nowIso(),
    monitors
  };
  return commitTx(pi, cwd, {
    request_id: requestId,
    message,
    writes: [{ path: relativeStatePath("watchdogJobs"), expected_revision: previous.revision, content: next }],
    deletes: []
  });
}

function assertMonitorName(name: string): MonitorName {
  if ((MONITOR_NAMES as readonly string[]).includes(name)) return name as MonitorName;
  throw new Error(`unknown monitor "${name}"`);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number): void {
  if (!isPidAlive(pid)) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

function formatMonitorStatus(monitors: Record<string, MonitorRecord>): string {
  const values = Object.values(monitors);
  if (values.length === 0) return "No monitors recorded.";
  return values
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((monitor) => `${monitor.name} [${monitor.status}] pid=${monitor.pid} interval=${monitor.interval_ms}ms`)
    .join("\n");
}
