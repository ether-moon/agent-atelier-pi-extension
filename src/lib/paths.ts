import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = path.resolve(srcDir, "..");

export function extensionRoot(): string {
  return rootDir;
}

export function assetPath(...parts: string[]): string {
  return path.join(extensionRoot(), ...parts);
}

export function repoRoot(cwd = process.cwd()): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return path.resolve(cwd);
  }
}

export function stateDir(root: string): string {
  return path.join(root, ".agent-atelier");
}

export function loopStatePath(root: string): string {
  return path.join(stateDir(root), "loop-state.json");
}

export function workItemsPath(root: string): string {
  return path.join(stateDir(root), "work-items.json");
}

export function watchdogJobsPath(root: string): string {
  return path.join(stateDir(root), "watchdog-jobs.json");
}

export function gatesDir(root: string): string {
  return path.join(stateDir(root), "human-gates");
}

export function gateOpenDir(root: string): string {
  return path.join(gatesDir(root), "open");
}

export function gateResolvedDir(root: string): string {
  return path.join(gatesDir(root), "resolved");
}

export function gateIndexPath(root: string): string {
  return path.join(gatesDir(root), "_index.md");
}

export function pendingTxPath(root: string): string {
  return path.join(stateDir(root), ".pending-tx.json");
}

export function eventsPath(root: string): string {
  return path.join(stateDir(root), "events.ndjson");
}

export function validationDir(root: string): string {
  return path.join(stateDir(root), "validation");
}

export function stateExists(root: string): boolean {
  return existsSync(loopStatePath(root)) && existsSync(workItemsPath(root)) && existsSync(watchdogJobsPath(root));
}

export function relativeStatePath(name: "loop" | "workItems" | "watchdogJobs"): string {
  if (name === "loop") return ".agent-atelier/loop-state.json";
  if (name === "workItems") return ".agent-atelier/work-items.json";
  return ".agent-atelier/watchdog-jobs.json";
}
