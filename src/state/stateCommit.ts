import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { assetPath, repoRoot } from "../lib/paths.js";
import type { StateTransaction } from "../lib/types.js";

export class StateCommitError extends Error {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly details: unknown;

  constructor(message: string, code: number, stdout: string, stderr: string, details: unknown) {
    super(message);
    this.name = "StateCommitError";
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
    this.details = details;
  }
}

export async function commitTx(pi: ExtensionAPI, cwd: string, tx: StateTransaction): Promise<Record<string, unknown>> {
  return runStateCommit(pi, cwd, JSON.stringify(tx));
}

export async function commitVerb(
  pi: ExtensionAPI,
  cwd: string,
  verb: string,
  target: string | null,
  fields: Record<string, unknown>,
  basedOnRevision: number
): Promise<Record<string, unknown>> {
  return runStateCommit(
    pi,
    cwd,
    JSON.stringify({
      verb,
      target,
      fields,
      based_on_revision: basedOnRevision
    })
  );
}

export async function replayPendingTx(pi: ExtensionAPI, cwd: string): Promise<Record<string, unknown>> {
  const root = repoRoot(cwd);
  const scriptPath = assetPath("scripts", "state-commit");
  const result = await pi.exec("bash", ["-lc", "\"$1\" --root \"$2\" --replay", "state-commit-replay", scriptPath, root], {
    cwd: root
  });
  return parseCommitResult(result.code, result.stdout, result.stderr);
}

async function runStateCommit(pi: ExtensionAPI, cwd: string, input: string): Promise<Record<string, unknown>> {
  const root = repoRoot(cwd);
  const scriptPath = assetPath("scripts", "state-commit");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "aa-state-"));
  const txPath = path.join(tmpDir, "tx.json");

  try {
    await fs.writeFile(txPath, input, { encoding: "utf-8", mode: 0o600 });
    const result = await pi.exec(
      "bash",
      ["-lc", "cat \"$1\" | \"$2\" --root \"$3\"", "state-commit", txPath, scriptPath, root],
      { cwd: root }
    );
    return parseCommitResult(result.code, result.stdout, result.stderr);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

function parseCommitResult(code: number, stdout: string, stderr: string): Record<string, unknown> {
  let parsed: unknown = null;
  if (stdout.trim()) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = { raw: stdout };
    }
  }

  if (code !== 0) {
    const reason =
      parsed && typeof parsed === "object" && "reason" in parsed ? String((parsed as { reason: unknown }).reason) : stderr;
    throw new StateCommitError(reason || `state-commit exited ${code}`, code, stdout, stderr, parsed);
  }

  return (parsed ?? {}) as Record<string, unknown>;
}
