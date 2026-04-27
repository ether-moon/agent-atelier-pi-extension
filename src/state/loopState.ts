import { loopStatePath, repoRoot } from "../lib/paths.js";
import type { LoopState } from "../lib/types.js";
import { readJsonFile, tryReadJsonFile } from "./readJson.js";

export function readLoopState(cwd: string): LoopState {
  return readJsonFile<LoopState>(loopStatePath(repoRoot(cwd)));
}

export function tryReadLoopState(cwd: string): LoopState | null {
  return tryReadJsonFile<LoopState>(loopStatePath(repoRoot(cwd)));
}
