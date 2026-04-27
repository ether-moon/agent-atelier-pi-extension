import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { assetPath, repoRoot } from "../lib/paths.js";

const REQUIRED_FIELDS = [
  "candidate_set_id",
  "work_item_ids",
  "behavior_spec_revision",
  "target_branch",
  "target_commit",
  "acceptance_criteria_refs",
  "verification_commands",
  "forbidden_context"
];

export async function buildVrmPrompt(pi: ExtensionAPI, cwd: string): Promise<Record<string, unknown>> {
  const root = repoRoot(cwd);
  const scriptPath = assetPath("scripts", "build-vrm-prompt");
  const result = await pi.exec("bash", ["-lc", "\"$1\" --root \"$2\"", "build-vrm-prompt", scriptPath, root], { cwd: root });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `build-vrm-prompt exited ${result.code}`);
  }
  const payload = JSON.parse(result.stdout) as Record<string, unknown>;
  validateVrmPrompt(payload);
  return payload;
}

export function validateVrmPrompt(payload: Record<string, unknown>): void {
  for (const field of REQUIRED_FIELDS) {
    if (!(field in payload)) throw new Error(`VRM prompt missing required field: ${field}`);
  }
  if (!Array.isArray(payload.work_item_ids) || payload.work_item_ids.length === 0) {
    throw new Error("VRM prompt work_item_ids must be non-empty");
  }
  if (!Array.isArray(payload.verification_commands) || payload.verification_commands.length === 0) {
    throw new Error("VRM prompt verification_commands must be non-empty");
  }
  if (!Array.isArray(payload.acceptance_criteria_refs) || payload.acceptance_criteria_refs.length === 0) {
    throw new Error("VRM prompt acceptance_criteria_refs must be non-empty");
  }
  if (!Array.isArray(payload.forbidden_context)) {
    throw new Error("VRM prompt forbidden_context must be an array");
  }
}
