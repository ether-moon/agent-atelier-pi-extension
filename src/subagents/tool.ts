import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { discoverAgents, formatAgentList } from "./agents.js";
import { getFinalOutput, mapWithConcurrencyLimit, runSingleAgent, type SingleResult, type SubagentDetails } from "./spawn.js";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;

const TaskItem = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" }))
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String({ description: "Name of the agent to invoke for single mode" })),
  task: Type.Optional(Type.String({ description: "Task to delegate for single mode" })),
  tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks" })),
  chain: Type.Optional(Type.Array(TaskItem, { description: "Sequential tasks; {previous} is replaced with prior output" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for single mode" }))
});

export function registerSubagentTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "aa-subagent",
    label: "Atelier Subagent",
    description:
      "Delegate tasks to bundled agent-atelier agents. Modes: single (agent + task), parallel (tasks array), or chain.",
    parameters: SubagentParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const discovery = discoverAgents();
      const agents = discovery.agents;
      const hasChain = Boolean(params.chain?.length);
      const hasTasks = Boolean(params.tasks?.length);
      const hasSingle = Boolean(params.agent && params.task);
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);

      const makeDetails =
        (mode: "single" | "parallel" | "chain") =>
        (results: SingleResult[]): SubagentDetails => ({
          mode,
          agentsDir: discovery.agentsDir,
          results
        });

      if (modeCount !== 1) {
        const list = formatAgentList(agents, 20);
        return {
          content: [{ type: "text" as const, text: `Invalid parameters. Provide exactly one mode.\nAvailable agents: ${list.text}` }],
          details: makeDetails("single")([])
        };
      }

      if (params.chain?.length) {
        const results: SingleResult[] = [];
        let previousOutput = "";
        for (let i = 0; i < params.chain.length; i++) {
          const step = params.chain[i];
          const taskWithContext = step.task.replace(/\{previous\}/g, previousOutput);
          const result = await runSingleAgent(
            ctx.cwd,
            agents,
            discovery.agentsDir,
            step.agent,
            taskWithContext,
            step.cwd,
            i + 1,
            signal,
            onUpdate
              ? (partial) => {
                  const current = partial.details?.results[0];
                  if (current) onUpdate({ content: partial.content, details: makeDetails("chain")([...results, current]) });
                }
              : undefined,
            makeDetails("chain")
          );
          results.push(result);
          const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
          if (isError) {
            const error = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
            return {
              content: [{ type: "text" as const, text: `Chain stopped at step ${i + 1} (${step.agent}): ${error}` }],
              details: makeDetails("chain")(results),
              isError: true
            };
          }
          previousOutput = getFinalOutput(result.messages);
        }
        return {
          content: [{ type: "text" as const, text: getFinalOutput(results[results.length - 1].messages) || "(no output)" }],
          details: makeDetails("chain")(results)
        };
      }

      if (params.tasks?.length) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          return {
            content: [{ type: "text" as const, text: `Too many parallel tasks; max is ${MAX_PARALLEL_TASKS}.` }],
            details: makeDetails("parallel")([])
          };
        }
        const allResults: SingleResult[] = params.tasks.map((task) => ({
          agent: task.agent,
          agentSource: "unknown",
          task: task.task,
          exitCode: -1,
          messages: [],
          stderr: "",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }
        }));
        const emitParallelUpdate = () => {
          const done = allResults.filter((result) => result.exitCode !== -1).length;
          const running = allResults.length - done;
          onUpdate?.({
            content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
            details: makeDetails("parallel")([...allResults])
          });
        };
        const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (task, index) => {
          const result = await runSingleAgent(
            ctx.cwd,
            agents,
            discovery.agentsDir,
            task.agent,
            task.task,
            task.cwd,
            undefined,
            signal,
            (partial) => {
              if (partial.details?.results[0]) {
                allResults[index] = partial.details.results[0];
                emitParallelUpdate();
              }
            },
            makeDetails("parallel")
          );
          allResults[index] = result;
          emitParallelUpdate();
          return result;
        });
        const successCount = results.filter((result) => result.exitCode === 0).length;
        const summaries = results.map((result) => {
          const output = getFinalOutput(result.messages);
          return `[${result.agent}] ${result.exitCode === 0 ? "completed" : "failed"}: ${output.slice(0, 120) || "(no output)"}`;
        });
        return {
          content: [{ type: "text" as const, text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n")}` }],
          details: makeDetails("parallel")(results)
        };
      }

      if (params.agent && params.task) {
        const result = await runSingleAgent(
          ctx.cwd,
          agents,
          discovery.agentsDir,
          params.agent,
          params.task,
          params.cwd,
          undefined,
          signal,
          onUpdate,
          makeDetails("single")
        );
        const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
        if (isError) {
          const error = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
          return {
            content: [{ type: "text" as const, text: `Agent failed: ${error}` }],
            details: makeDetails("single")([result]),
            isError: true
          };
        }
        return {
          content: [{ type: "text" as const, text: getFinalOutput(result.messages) || "(no output)" }],
          details: makeDetails("single")([result])
        };
      }

      return { content: [{ type: "text" as const, text: "Invalid parameters." }], details: makeDetails("single")([]) };
    },
    renderCall(args, theme) {
      const label = args.chain?.length
        ? `chain (${args.chain.length})`
        : args.tasks?.length
          ? `parallel (${args.tasks.length})`
          : args.agent || "...";
      return new Text(theme.fg("toolTitle", theme.bold("aa-subagent ")) + theme.fg("accent", label), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (!details?.results.length) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
      }
      const lines = details.results.map((entry) => {
        const mark = entry.exitCode === 0 ? theme.fg("success", "ok") : theme.fg("error", "fail");
        return `${mark} ${theme.fg("accent", entry.agent)} ${getFinalOutput(entry.messages).split("\n")[0] || entry.stderr || "(no output)"}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    }
  });
}
