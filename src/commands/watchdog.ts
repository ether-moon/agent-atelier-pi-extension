import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parseArgs, requireRequestId } from "../lib/argparse.js";
import { formatJson, postText } from "../lib/output.js";
import { relativeStatePath } from "../lib/paths.js";
import { nowIso } from "../lib/time.js";
import type { StateTransaction } from "../lib/types.js";
import { commitTx } from "../state/stateCommit.js";
import { readWatchdogJobs } from "../state/watchdogJobs.js";
import { bumpWorkItemsStore, cloneWorkItems, readWorkItems } from "../state/workItems.js";
import { refreshAtelierWidgets } from "../ui/refresh.js";

export function registerWatchdogCommand(pi: ExtensionAPI): void {
  pi.registerCommand("aa-watchdog", {
    description: "Run one mechanical recovery tick",
    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      if (parsed.verb !== "tick" && parsed.verb !== "") throw new Error("usage: /aa-watchdog tick --request-id <id>");
      const requestId = requireRequestId(parsed.options);
      const jobs = readWatchdogJobs(ctx.cwd);
      const store = readWorkItems(ctx.cwd);
      const nextWork = bumpWorkItemsStore(cloneWorkItems(store));
      const now = Date.now();
      const alerts: string[] = [];

      for (const item of nextWork.items) {
        if (item.status !== "implementing" || !item.lease_expires_at) continue;
        if (Date.parse(item.lease_expires_at) > now) continue;
        item.status = "ready";
        item.owner_session_id = null;
        item.last_heartbeat_at = null;
        item.lease_expires_at = null;
        item.stale_requeue_count += 1;
        item.last_requeue_reason = "watchdog: stale lease";
        item.revision += 1;
        alerts.push(`${item.id}: stale lease requeued`);
      }

      const nextJobs = {
        ...jobs,
        revision: jobs.revision + 1,
        updated_at: nowIso(),
        last_tick_at: nowIso(),
        open_alerts: alerts.length ? [...jobs.open_alerts, ...alerts] : jobs.open_alerts
      };

      const writes: StateTransaction["writes"] = [
        { path: relativeStatePath("watchdogJobs"), expected_revision: jobs.revision, content: nextJobs }
      ];
      if (alerts.length) writes.push({ path: relativeStatePath("workItems"), expected_revision: store.revision, content: nextWork });

      const result = await commitTx(pi, ctx.cwd, {
        request_id: requestId,
        message: "aa-watchdog tick",
        writes,
        deletes: []
      });
      refreshAtelierWidgets(ctx);
      postText(pi, `Watchdog tick complete (${alerts.length} alert${alerts.length === 1 ? "" : "s"}).\n\n${formatJson(result)}`, {
        ...result,
        alerts
      });
    }
  });
}
