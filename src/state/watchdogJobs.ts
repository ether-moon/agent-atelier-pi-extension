import { repoRoot, watchdogJobsPath } from "../lib/paths.js";
import type { WatchdogJobs } from "../lib/types.js";
import { readJsonFile, tryReadJsonFile } from "./readJson.js";

export function readWatchdogJobs(cwd: string): WatchdogJobs {
  return readJsonFile<WatchdogJobs>(watchdogJobsPath(repoRoot(cwd)));
}

export function tryReadWatchdogJobs(cwd: string): WatchdogJobs | null {
  return tryReadJsonFile<WatchdogJobs>(watchdogJobsPath(repoRoot(cwd)));
}
