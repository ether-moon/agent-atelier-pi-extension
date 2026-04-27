#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const [name, root, rawInterval] = process.argv.slice(2);
const intervalMs = Math.max(1000, Number(rawInterval || 15000));
const stateDir = path.join(root, ".agent-atelier");
const eventsPath = path.join(stateDir, "events.ndjson");

if (!name || !root) process.exit(1);

appendEvent("monitor_started", { monitor: name, interval_ms: intervalMs });

let lastEventSize = 0;
let lastCiCommit = null;
let lastDivergence = null;

const timer = setInterval(() => {
  try {
    tick(name);
  } catch (error) {
    appendEvent("monitor_error", { monitor: name, message: error instanceof Error ? error.message : String(error) });
  }
}, intervalMs);

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

function shutdown(signal) {
  clearInterval(timer);
  appendEvent("monitor_stopped", { monitor: name, signal });
  process.exit(0);
}

function tick(monitor) {
  if (monitor === "heartbeat-watch") return heartbeatWatch();
  if (monitor === "gate-watch") return gateWatch();
  if (monitor === "event-tail") return eventTail();
  if (monitor === "ci-status") return ciStatus();
  if (monitor === "branch-divergence") return branchDivergence();
  appendEvent("monitor_unknown", { monitor });
}

function heartbeatWatch() {
  const work = readJson("work-items.json");
  const now = Date.now();
  for (const item of work.items ?? []) {
    if (item.status !== "implementing" || !item.lease_expires_at) continue;
    const expiry = Date.parse(item.lease_expires_at);
    if (!Number.isFinite(expiry)) continue;
    const remainingMs = expiry - now;
    if (remainingMs <= 0) {
      appendEvent("heartbeat_expired", { monitor: name, work_item_id: item.id, lease_expires_at: item.lease_expires_at });
    } else if (remainingMs <= 10 * 60 * 1000) {
      appendEvent("heartbeat_warning", { monitor: name, work_item_id: item.id, lease_expires_at: item.lease_expires_at });
    }
  }
}

function gateWatch() {
  const jobs = readJson("watchdog-jobs.json");
  const warnHours = Number(jobs.defaults?.gate_warn_after_hours ?? 24);
  const openDir = path.join(stateDir, "human-gates", "open");
  if (!fs.existsSync(openDir)) return;
  for (const file of fs.readdirSync(openDir).filter((entry) => entry.endsWith(".json"))) {
    const gate = JSON.parse(fs.readFileSync(path.join(openDir, file), "utf-8"));
    const created = Date.parse(gate.created_at ?? "");
    if (Number.isFinite(created) && Date.now() - created >= warnHours * 60 * 60 * 1000) {
      appendEvent("gate_wait_warning", { monitor: name, gate_id: gate.id, created_at: gate.created_at });
    }
  }
}

function eventTail() {
  let size = 0;
  try {
    size = fs.statSync(eventsPath).size;
  } catch {
    return;
  }
  if (lastEventSize === 0) {
    lastEventSize = size;
    return;
  }
  if (size !== lastEventSize) {
    appendEvent("event_log_advanced", { monitor: name, previous_size: lastEventSize, current_size: size });
    lastEventSize = size;
  }
}

function ciStatus() {
  const loop = readJson("loop-state.json");
  const active = loop.active_candidate_set;
  if (!active) return;
  const commit = git(["rev-parse", "--verify", active.commit || "HEAD"]);
  if (!commit || commit === lastCiCommit) return;
  lastCiCommit = commit;
  appendEvent("ci_candidate_seen", {
    monitor: name,
    candidate_set_id: active.id,
    branch: active.branch,
    commit
  });
}

function branchDivergence() {
  const base = git(["rev-parse", "--verify", "origin/main"], false) ? "origin/main" : git(["rev-parse", "--verify", "main"], false) ? "main" : null;
  if (!base) return;
  const counts = git(["rev-list", "--left-right", "--count", `${base}...HEAD`], false);
  if (!counts || counts === lastDivergence) return;
  lastDivergence = counts;
  const [behind, ahead] = counts.split(/\s+/).map(Number);
  appendEvent("branch_divergence", { monitor: name, base, behind, ahead });
}

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, fileName), "utf-8"));
}

function git(args, throwOnError = true) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: ["ignore", "pipe", throwOnError ? "pipe" : "ignore"] }).trim();
  } catch (error) {
    if (throwOnError) throw error;
    return "";
  }
}

function appendEvent(event, fields = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.appendFileSync(
    eventsPath,
    `${JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      ...fields
    })}\n`
  );
}
