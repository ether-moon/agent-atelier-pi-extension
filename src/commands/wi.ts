import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { optionString, parseArgs, parseJsonOrFields, requireRequestId } from "../lib/argparse.js";
import { formatJson, postText } from "../lib/output.js";
import { relativeStatePath } from "../lib/paths.js";
import { nowIso } from "../lib/time.js";
import { commitTx } from "../state/stateCommit.js";
import { bumpWorkItemsStore, cloneWorkItems, findWorkItem, normalizeWorkItem, readWorkItems } from "../state/workItems.js";
import { refreshAtelierWidgets } from "../ui/refresh.js";
import { renderWorkItems } from "../ui/widgets.js";

export function registerWiCommand(pi: ExtensionAPI): void {
  pi.registerCommand("aa-wi", {
    description: "List, show, or upsert work items",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      if (parsed.verb === "list" || parsed.verb === "") {
        const store = readWorkItems(ctx.cwd);
        postText(pi, renderWorkItems(store), { workItems: store.items });
        return;
      }

      if (parsed.verb === "show") {
        const id = parsed.positionals[0] ?? optionString(parsed.options, "id");
        if (!id) throw new Error("usage: /aa-wi show <WI-ID>");
        const store = readWorkItems(ctx.cwd);
        const item = findWorkItem(store, id);
        postText(pi, item ? formatJson(item) : `${id} not found.`);
        return;
      }

      if (parsed.verb === "upsert") {
        const requestId = requireRequestId(parsed.options);
        const payload = parseJsonOrFields(parsed.positionals, parsed.options, ctx.cwd);
        const store = readWorkItems(ctx.cwd);
        const next = bumpWorkItemsStore(cloneWorkItems(store));
        const existingIndex = next.items.findIndex((item) => item.id === payload.id);
        const existing = existingIndex === -1 ? undefined : next.items[existingIndex];
        const normalized = normalizeWorkItem(payload, existing);
        if (existingIndex === -1) next.items.push(normalized);
        else next.items[existingIndex] = normalized;
        next.updated_at = nowIso();

        const result = await commitTx(pi, ctx.cwd, {
          request_id: requestId,
          message: `aa-wi upsert ${normalized.id}`,
          writes: [{ path: relativeStatePath("workItems"), expected_revision: store.revision, content: next }],
          deletes: []
        });
        refreshAtelierWidgets(ctx);
        postText(pi, `Upserted ${normalized.id}.\n\n${formatJson(result)}`, result);
        return;
      }

      throw new Error("usage: /aa-wi list | show <WI-ID> | upsert <json-or-fields> --request-id <id>");
    }
  });
}
