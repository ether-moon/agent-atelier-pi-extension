import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { optionString, parseArgs, parseJsonOrFields, requireRequestId } from "../lib/argparse.js";
import { formatJson, postText } from "../lib/output.js";
import { relativeStatePath, repoRoot } from "../lib/paths.js";
import { nowIso } from "../lib/time.js";
import type { StateTransaction } from "../lib/types.js";
import { readLoopState } from "../state/loopState.js";
import { commitTx } from "../state/stateCommit.js";
import { buildVrmPrompt } from "../state/vrmPrompt.js";
import { bumpWorkItemsStore, cloneWorkItems, readWorkItems } from "../state/workItems.js";
import { refreshAtelierWidgets } from "../ui/refresh.js";

export function registerValidateCommand(pi: ExtensionAPI): void {
  pi.registerCommand("aa-validate", {
    description: "Record validation manifests and update candidate state",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      if (parsed.verb !== "record") throw new Error("usage: /aa-validate record <json> --request-id <id>");
      const requestId = requireRequestId(parsed.options);
      const root = repoRoot(ctx.cwd);
      const manifestPath = optionString(parsed.options, "manifest-path");
      const manifest = manifestPath
        ? (JSON.parse(fs.readFileSync(path.resolve(root, manifestPath), "utf-8")) as Record<string, unknown>)
        : parseJsonOrFields(parsed.positionals, parsed.options, ctx.cwd);

      normalizeManifest(manifest);
      const id = String(manifest.id);
      const relManifestPath = `.agent-atelier/validation/${id}/manifest.json`;
      const manifestWrite: StateTransaction["writes"][number] = {
        path: relManifestPath,
        expected_revision: null,
        content: manifest
      };

      const status = String(manifest.status);
      if (status === "environment_error") {
        const result = await commitTx(pi, ctx.cwd, {
          request_id: requestId,
          message: `aa-validate record ${id}`,
          writes: [manifestWrite],
          deletes: []
        });
        refreshAtelierWidgets(ctx);
        postText(pi, `Recorded environment-error validation manifest ${relManifestPath}; state unchanged.\n\n${formatJson(result)}`, result);
        return;
      }

      const loop = readLoopState(ctx.cwd);
      const active = loop.active_candidate_set;
      if (!active) throw new Error("no active candidate set");
      const ids = manifest.work_item_ids as string[];
      if (manifest.candidate_set_id !== active.id) throw new Error("candidate_set_id does not match active candidate set");
      if (String(manifest.candidate_branch) !== active.branch || String(manifest.candidate_commit) !== active.commit) {
        throw new Error("candidate branch/commit does not match active candidate set");
      }
      if (JSON.stringify([...ids].sort()) !== JSON.stringify([...active.work_item_ids].sort())) {
        throw new Error("manifest work_item_ids do not match active candidate set");
      }
      await buildVrmPrompt(pi, ctx.cwd);

      const store = readWorkItems(ctx.cwd);
      const nextWork = bumpWorkItemsStore(cloneWorkItems(store));
      for (const wiId of ids) {
        const item = nextWork.items.find((candidate) => candidate.id === wiId);
        if (!item) throw new Error(`${wiId} not found`);
        if (item.status !== "candidate_validating") throw new Error(`${wiId} is ${item.status}; expected candidate_validating`);
        if (status === "passed") {
          item.status = "reviewing";
          item.promotion.status = "reviewing";
        } else {
          item.status = "ready";
          item.promotion = { candidate_branch: null, candidate_commit: null, status: "not_ready" };
        }
        item.revision += 1;
      }

      const writes: StateTransaction["writes"] = [
        manifestWrite,
        { path: relativeStatePath("workItems"), expected_revision: store.revision, content: nextWork }
      ];
      if (status === "failed") {
        writes.push({
          path: relativeStatePath("loop"),
          expected_revision: loop.revision,
          content: {
            ...loop,
            revision: loop.revision + 1,
            updated_at: nowIso(),
            active_candidate_set: null,
            mode: "IMPLEMENT",
            next_action: { owner: "orchestrator", type: "resume_rework", target: active.id }
          }
        });
      }

      const result = await commitTx(pi, ctx.cwd, {
        request_id: requestId,
        message: `aa-validate record ${id}`,
        writes,
        deletes: []
      });
      refreshAtelierWidgets(ctx);
      postText(pi, `Recorded validation ${id} (${status}).\n\n${formatJson(result)}`, result);
    }
  });
}

function normalizeManifest(manifest: Record<string, unknown>): void {
  manifest.id ??= `RUN-${nowIso().replace(/[-:]/g, "").replace("T", "-").replace("Z", "")}`;
  manifest.started_at ??= nowIso();
  manifest.finished_at ??= nowIso();
  if (!manifest.candidate_set_id) throw new Error("manifest requires candidate_set_id");
  if (!Array.isArray(manifest.work_item_ids) || manifest.work_item_ids.length === 0) {
    throw new Error("manifest requires non-empty work_item_ids");
  }
  if (!manifest.candidate_branch || !manifest.candidate_commit) throw new Error("manifest requires candidate_branch and candidate_commit");
  if (!["passed", "failed", "environment_error"].includes(String(manifest.status))) {
    throw new Error("manifest status must be passed, failed, or environment_error");
  }
  if (!Array.isArray(manifest.checks) || manifest.checks.length === 0) throw new Error("manifest requires checks");
  manifest.evidence_refs ??= [];
}
