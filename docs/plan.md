# Implementation Plan: agent-atelier as a pi-coding-agent extension

## Context

Port the upstream [agent-atelier](https://github.com/ether-moon/agent-atelier) Claude Code plugin to a single **pi-coding-agent** extension while preserving the orchestration loop and operational artifacts (state files, scripts, schemas, role prompts) verbatim. This document is the source of truth for the implementation; it consolidates and supersedes the prior design / mapping / roadmap notes.

## References

| Source | Use |
|---|---|
| pi extensions API — `badlogic/pi-mono`, `packages/coding-agent/docs/extensions.md` | `ExtensionAPI`, events, `ctx.ui`, registration calls |
| pi subagent example — `examples/extensions/subagent/{index,agents}.ts` | Pattern for spawning subagent processes — to be vendored |
| pi plan-mode example — `examples/extensions/plan-mode/{index,utils}.ts` | Bash allowlist, `setActiveTools`, plan extraction patterns |
| Upstream agent-atelier — `ether-moon/agent-atelier` | Source for skills, hooks, agents, scripts, schema, refs |

## Architectural decisions (grounded in pi reference)

1. **Subagent dispatch — vendor the example.** pi has no first-class subagent registry. The example pattern is a single LLM tool that spawns `pi --mode json -p --no-session --append-system-prompt <prompt-file> --tools <list>` subprocesses with three modes (single / parallel / chain). Vendor that pattern as `src/subagents/{agents.ts, spawn.ts, tool.ts}`, replacing the example's bundled scout/planner/reviewer/worker with our 8 atelier agents. Tool name: `aa-subagent` (prefixed to avoid collision if a user has the upstream example installed).

2. **Plan mode — encoded in agent identity, not runtime toggle.** `pi.setActiveTools()` only toggles the *parent* session, so it cannot scope tools per-spawn. Instead ship two builder variants: `agents/builder.md` (full tools) and `agents/builder-plan.md` (`tools: read, grep, find, ls, bash`). The orchestrator picks the variant by reading `complexity` on the WI. The `--tools` flag of the spawned subprocess enforces the restriction; the `tool_call` handler additionally enforces a bash allowlist (lifted from `plan-mode/utils.ts`) as a safety net for the parent session.

3. **Plan approval — `ExitPlanMode` registered tool + `ctx.ui.confirm`.** Register an `ExitPlanMode` tool whose handler triggers `ctx.ui.confirm("Approve plan?", planText)`. On approval, the orchestrator respawns the builder using the unrestricted `builder` agent, passing the approved plan as task context. Respawn-on-approval is the accepted trade-off — pi cannot dynamically grant tools to a running spawn.

4. **Tool-name normalization.** Single source of truth in `src/lib/tools.ts`. Maps Claude Code names (e.g. `Bash, Read, Edit, Glob, Grep, LSP`) → pi names (`bash, read, edit, find, grep, ...`). Used at agent-load time, rewriting the `tools:` frontmatter when bundled markdown is loaded. The `tool_call` event handler reads `event.toolName`, which pi already emits in canonical form, so no second normalization pass is needed there.

5. **State writes via bash, reads via TS.** All mutations call `scripts/state-commit` through `pi.exec("bash", [scriptPath, ...args], { input })`. Reads are direct `fs.readFile` from TS. The bash script preserves the upstream sole-writer / fcntl-locked atomic-write guarantees. A lint rule forbids direct writes to `.agent-atelier/*.json` outside the bridge.

6. **Orchestrator system prompt — `before_agent_start`.** pi has no `setSystemPrompt`. The `/aa-run` command sets a module-level flag; a `before_agent_start` handler appends `prompts/orchestrator.md` to `event.systemPrompt` when the flag is on. (This is the supported extension point per the API doc's "System Prompt Integration" section.)

7. **UI surface.** `ctx.ui.setWidget("aa-active-wis", ...)` for the WI dashboard (replaces upstream `TaskList` sync). `ctx.ui.notify(msg, type)` for transient toasts. `ctx.ui.confirm(...)` for plan approval and gate prompts. `ctx.ui.editor(...)` for plan-rejection feedback.

## File layout

```
agent-atelier-pi-extension/
├── README.md
├── LICENSE
├── package.json                 # peer dep on @mariozechner/pi-coding-agent
├── tsconfig.json
├── src/
│   ├── index.ts                 # default export — extension factory
│   ├── commands/                # one file per pi command
│   │   ├── init.ts              # /aa-init
│   │   ├── status.ts            # /aa-status
│   │   ├── wi.ts                # /aa-wi list|show|upsert
│   │   ├── execute.ts           # /aa-execute claim|heartbeat|requeue|complete|attempt
│   │   ├── candidate.ts         # /aa-candidate enqueue|activate|clear
│   │   ├── validate.ts          # /aa-validate record
│   │   ├── gate.ts              # /aa-gate list|open|resolve
│   │   ├── watchdog.ts          # /aa-watchdog tick
│   │   ├── monitors.ts          # /aa-monitors spawn|status|stop
│   │   └── run.ts               # /aa-run — orchestrator entry
│   ├── events/                  # event handlers
│   │   ├── input.ts             # was on-prompt.sh
│   │   ├── toolCall.ts          # was on-pre-tool-use.sh + plan-mode interception
│   │   ├── agentEnd.ts          # was on-stop.sh + on-task-completed.sh + teammate-idle bits
│   │   └── sessionStart.ts      # bootstrapping checks
│   ├── state/                   # state bridge
│   │   ├── stateCommit.ts       # wraps the bash script
│   │   ├── workItems.ts         # read-side helpers over work-items.json
│   │   ├── loopState.ts         # read-side helpers over loop-state.json
│   │   └── watchdogJobs.ts      # read-side helpers over watchdog-jobs.json
│   ├── subagents/
│   │   ├── agents.ts            # vendored from pi subagent/agents.ts — discoverAgents
│   │   ├── spawn.ts             # vendored from pi subagent/index.ts — runSingleAgent
│   │   └── tool.ts              # registers the `aa-subagent` LLM tool
│   ├── ui/
│   │   └── widgets.ts           # ctx.ui.setWidget renderers
│   └── lib/
│       ├── paths.ts             # mirrors references/paths.md
│       ├── argparse.ts          # shared <verb> [args...] parser
│       ├── tools.ts             # Claude → pi tool name mapping
│       ├── destructiveCommands.ts  # blocklist regex array
│       ├── safeBash.ts          # vendored from plan-mode/utils.ts — bash allowlist
│       └── types.ts             # WI status enum, lease shape, etc.
├── agents/                      # subagent markdown definitions
│   ├── architect.md
│   ├── builder.md
│   ├── builder-plan.md          # restricted variant for plan mode
│   ├── pm.md
│   ├── qa-reviewer.md
│   ├── state-manager.md
│   ├── ux-reviewer.md
│   └── vrm.md
├── prompts/                     # 11 role prompt bodies
├── scripts/                     # bash scripts ported as-is
│   ├── state-commit
│   └── build-vrm-prompt
├── schema/
│   └── vrm-evidence-input.schema.json
├── references/                  # static reference docs
└── tests/
    └── all.sh
```

## Phases

Each phase lists **concrete files**, **APIs to call**, and **how to verify**. Earlier phases are ordered to minimize rework: assets that change least move first; the most uncertain pieces (subagent spawn, plan mode) move last.

### Phase 1 — Scaffold + asset mirror

**Files to create:**
- `package.json` — peer dep `@mariozechner/pi-coding-agent` (pin to a tested commit), runtime deps `typebox`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`. `type: "module"`. Entry `./src/index.ts`.
- `tsconfig.json` — `target: ES2022`, `module: NodeNext`, `moduleResolution: NodeNext`, strict.
- `src/index.ts` — `export default function (pi: ExtensionAPI) {}` (no-op).
- `.gitignore` — adds `node_modules`, `.agent-atelier/` (runtime state), `*.tgz`.

**Files to copy verbatim from upstream `ether-moon/agent-atelier`:**
- `plugins/agent-atelier/scripts/state-commit` → `scripts/state-commit` (chmod +x)
- `plugins/agent-atelier/scripts/build-vrm-prompt` → `scripts/build-vrm-prompt` (chmod +x)
- `plugins/agent-atelier/schema/vrm-evidence-input.schema.json` → `schema/`
- `plugins/agent-atelier/references/{paths,state-defaults,wi-schema,recovery-protocol,success-metrics-routing}.md` → `references/`
- `plugins/agent-atelier/references/prompts/*.md` (11 files) → `prompts/` (only `orchestrator.md` will be adapted in a later phase)

**Files to adapt from upstream `.claude/agents/*.md`:**
For each of `architect, builder, pm, qa-reviewer, state-manager, ux-reviewer, vrm`:
- Copy body verbatim.
- Rewrite `tools:` frontmatter using the Claude→pi mapping table (`src/lib/tools.ts` constant).
- Normalize `model:` aliases: `opus → claude-opus-4-7`, `sonnet → claude-sonnet-4-6`, `haiku → claude-haiku-4-5-20251001`.
- Output to `agents/<name>.md`.

**Verify:**
```
pi -e ./src/index.ts
```
Loads cleanly with no command/tool/event registered.

---

### Phase 2 — State bridge + read-only commands

**Critical files:**
- `src/state/stateCommit.ts` — wraps `pi.exec("bash", [scriptPath, ...args], { input: jsonString })`. Two functions: `commitTx(tx)` for normal transactions, `commitVerb(verb, target, fields, basedOnRevision)` for verb-mode. Returns parsed JSON result; throws typed errors on exit codes 1/2/4.
- `src/state/{loopState,workItems,watchdogJobs}.ts` — read helpers. Each exports `read<File>()` returning a parsed, typed object (types in `src/lib/types.ts` matching `references/wi-schema.md`).
- `src/lib/paths.ts` — mirrors `references/paths.md`: `loopStatePath()`, `workItemsPath()`, `gatesDir()`, etc., all relative to `git rev-parse --show-toplevel`.
- `src/commands/init.ts` — `pi.registerCommand("aa-init", ...)`. Handler: calls `state-commit` with default contents from `references/state-defaults.md`. Idempotent (skip writes if files exist with revision ≥ 1).
- `src/commands/status.ts` — `pi.registerCommand("aa-status", ...)`. Reads three state files, renders dashboard via `ctx.ui.setWidget("aa-status", lines)` and a text echo.
- `src/commands/wi.ts` — `pi.registerCommand("aa-wi", ...)`. Subcommands `list`, `show`. (`upsert` deferred to Phase 3.) Argument grammar verbatim from upstream `skills/wi/SKILL.md`.
- `src/commands/gate.ts` — `pi.registerCommand("aa-gate", ...)`. Subcommand `list` only. (`open`, `resolve` deferred to Phase 3.)
- `src/lib/argparse.ts` — shared `<verb> [args...]` parser used by every subcommand-bearing command.
- `src/ui/widgets.ts` — `renderStatusWidget(state)` helper.

**Verify:**
1. In an empty cwd: `/aa-init` writes `.agent-atelier/{loop-state,work-items,watchdog-jobs}.json` with `revision: 1` and content matching `references/state-defaults.md`.
2. `/aa-status` shows `mode: DISCOVER`, no open gates, no candidate set.
3. `/aa-wi list` shows "No work items".
4. `/aa-wi show WI-999` shows "not found".

---

### Phase 3 — Mutating commands + non-subagent events

**Critical files:**

Commands (each file registers one `pi.registerCommand(...)`; argument grammar verbatim from the corresponding upstream `skills/<name>/SKILL.md`):
- `src/commands/wi.ts` — add `upsert <json-or-fields>` subcommand (calls `state-commit` normal tx).
- `src/commands/execute.ts` — `claim`, `heartbeat`, `requeue`, `complete`, `attempt`. `heartbeat` uses verb-mode `state-commit` (no SM roundtrip per upstream). All require `--request-id`.
- `src/commands/candidate.ts` — `enqueue`, `activate`, `clear`.
- `src/commands/validate.ts` — `record`. Calls `scripts/build-vrm-prompt` via `pi.exec`, validates against `schema/vrm-evidence-input.schema.json`.
- `src/commands/gate.ts` — extend with `open <json>`, `resolve <HDR-ID> <chosen-option>`.
- `src/commands/watchdog.ts` — `tick` only. Mechanical recovery: stale-lease detection, budget enforcement.
- `src/commands/monitors.ts` — **stub in Phase 3** (returns "not implemented yet — see Phase 6"). Real implementation lands in Phase 6.
- `src/commands/run.ts` — orchestrator entry. Sets `orchestratorActive = true`. Real spawning of subagents arrives in Phase 4.

Events:
- `src/events/sessionStart.ts` — `pi.on("session_start", ...)`. Detect missing `.agent-atelier/`; if missing, `ctx.ui.notify("Run /aa-init to bootstrap", "info")`.
- `src/events/input.ts` — `pi.on("input", ...)`. Read `loop-state.json`; if `open_gates`, `active_candidate_set`, or `.pending-tx.json` present, return `{ action: "transform", text: event.text + "\n\n[atelier context: ...]" }`. Direct port of upstream `on-prompt.sh`.
- `src/events/toolCall.ts` (Phase 3 scope) — `pi.on("tool_call", ...)`. Destructive-bash blocklist port from upstream `on-pre-tool-use.sh`. Patterns (lifted verbatim from `lib/destructiveCommands.ts`): `rm -rf /`, `git push --force`, `git push -f`, `git reset --hard`, `git clean -fd`, `DROP TABLE`, `DROP DATABASE`, `DELETE FROM \S+;`, `TRUNCATE TABLE`, `migrate.*--destructive`, `migrate.*down all`, `chmod 777`, `curl|wget … | sh|bash`. Return `{block: true, reason: "..."}` on match. Plan-mode allowlist comes in Phase 5.
- `src/lib/destructiveCommands.ts` — exports the regex array and `isDestructive(cmd: string): {block: boolean, reason?: string}`.
- `src/events/agentEnd.ts` (skeleton) — `pi.on("agent_end", ...)`. Updates `setWidget("aa-active-wis", ...)`. Real subagent integration in Phase 4.

**Tests:**
- Port `tests/all.sh` from upstream, scoped to: schema validation, `state-commit --help`, mutation flow against the new commands. Subagent-dependent tests deferred.

**Verify:**
1. `bash tests/all.sh` (subset) green.
2. Manually: `/aa-init` → `/aa-wi upsert ...` (creates WI-001) → `/aa-execute claim WI-001 ...` → `/aa-execute heartbeat WI-001` → `/aa-execute complete WI-001 ...` → `/aa-status` shows `done`.
3. Try a blocked command (`bash` tool with `rm -rf /tmp/foo`): event returns `{block: true}`.

---

### Phase 4 — Subagent layer

**Critical files:**

- `src/subagents/agents.ts` — adapted from pi `examples/extensions/subagent/agents.ts`:
  - Lift `parseFrontmatter`, `loadAgentsFromDir`, `discoverAgents`, `formatAgentList` (small file, ~126 LOC).
  - Replace user-dir / project-dir scan with **bundled-dir scan** rooted at `path.dirname(fileURLToPath(import.meta.url)) + '/../../agents'`. No project-local override (atelier agents are part of the extension, not user-customizable).
  - Apply tool-name normalization (`src/lib/tools.ts`) to the frontmatter on load.

- `src/subagents/spawn.ts` — adapted from pi `examples/extensions/subagent/index.ts`:
  - Lift `runSingleAgent`, `mapWithConcurrencyLimit`, `getPiInvocation`, `writePromptToTempFile` (~200 LOC of harness).
  - Keep subprocess shape: `pi --mode json -p --no-session --model <m> --tools <t> --append-system-prompt <tmpfile>`.
  - Streaming: parse stdout line-by-line for `message_end` and `tool_result_end` JSON events; call `onUpdate(...)` for live progress.

- `src/subagents/tool.ts` — registers `aa-subagent` via `pi.registerTool({...})` with TypeBox schema:
  - Parameters: `{ agent?, task?, tasks?, chain?, cwd? }` (per pi example).
  - `execute()` dispatches to `runSingleAgent` / parallel / chain helpers in `spawn.ts`.
  - `renderCall` and `renderResult` lifted from the example (cosmetic; safe to keep).

- `src/events/agentEnd.ts` (extend) — when an `aa-subagent` invocation ends:
  - If the subagent claimed a WI (per `loop-state.json` `next_action.target`), call `state-commit` to release lease + update status.
  - Refresh `setWidget("aa-active-wis", ...)`.
  - Note: `agent_end` here is the *parent* session's agent_end after `aa-subagent` returns, since subagents run in their own pi processes (no cross-process events).

- `src/commands/run.ts` (extend) — orchestrator dispatch logic. Reads `loop-state.json` mode + active WI; based on phase, instructs the parent agent (via `pi.sendMessage` or via the system prompt added by `before_agent_start`) which agent to invoke through `aa-subagent`. Uses `prompts/orchestrator.md` as the role prompt (note: `orchestrator.md` must be edited in this phase to reference `aa-subagent` invocations and `/aa-*` command names — the only prompt that diverges from upstream).

- `src/index.ts` (extend) — wires `before_agent_start` to append `prompts/orchestrator.md` to the system prompt when `orchestratorActive` is true.

**Verify:**
1. Create a trivial WI with `complexity: "simple"`.
2. `/aa-run` → orchestrator decides BUILD_PLAN → calls `aa-subagent {agent: "architect", task: "..."}` → architect returns plan → orchestrator stores it → calls `aa-subagent {agent: "builder", task: "..."}` → builder implements → orchestrator transitions WI to `done`.
3. `setWidget` shows progress at each transition.

---

### Phase 5 — Plan approval flow

**Critical files:**

- `agents/builder-plan.md` (new) — copy of `agents/builder.md` body, but:
  - `tools: read, grep, find, ls, bash` (no `edit, write`).
  - Body appended with: "You are in plan mode. Produce a numbered plan under a `Plan:` header, then call `ExitPlanMode` with the plan text. Do not edit files."

- `src/lib/safeBash.ts` — vendor `isSafeCommand`, `DESTRUCTIVE_PATTERNS`, `SAFE_PATTERNS` from pi `examples/extensions/plan-mode/utils.ts`. Used by `events/toolCall.ts` when the active spawn's agent is `builder-plan`.

- `src/events/toolCall.ts` (extend) — additional check: if the current spawned subagent is `builder-plan` AND `event.toolName === "bash"`, run `isSafeCommand(event.input.command)`; on false, return `{block: true, reason: "..."}`. The active-agent identity is tracked via a module-level map keyed on `toolCallId` populated when `aa-subagent` starts.

- `src/index.ts` (extend) — register `ExitPlanMode` tool:
  - `pi.registerTool({ name: "ExitPlanMode", parameters: Type.Object({ plan: Type.String() }), execute: async (id, params, signal, onUpdate, ctx) => { const ok = await ctx.ui.confirm("Approve plan?", params.plan); if (ok) { return { content: [{type: "text", text: "approved"}], details: { approved: true, plan: params.plan }, terminate: true }; } else { const refinement = await ctx.ui.editor("Refine the plan", params.plan); return { content: [...], details: { approved: false, refinement } }; } } })`.

- `src/commands/run.ts` (extend) — orchestrator dispatch:
  - On WI with `complexity: "complex"`: spawn `builder-plan` first via `aa-subagent`. The spawn's tool result will include the approved plan (when `ExitPlanMode` returns `{approved: true}`).
  - On approval: respawn `builder` (unrestricted) with `task = "Implement this approved plan: <plan>"`.
  - On refinement: respawn `builder-plan` with the refinement appended to the original task.
  - Record approval/rejection on the WI via `state-commit`.

**Verify:**
1. Create WI with `complexity: "complex"`.
2. `/aa-run` → architect runs → builder-plan spawns with restricted tools → builder-plan emits plan + calls `ExitPlanMode` → UI shows confirm dialog with plan text.
3. Approve → builder respawns with full tools and the plan as task; implementation proceeds.
4. Reject + refine → builder-plan respawns with the refinement; cycle repeats.

---

### Phase 6 — Stabilization + monitors rewrite

- `src/ui/widgets.ts` — full WI dashboard widget (active WIs, candidate slot, open gates). Refresh on `agent_end`, `tool_result`, and after every `state-commit`.
- Recovery on session restart: `events/sessionStart.ts` checks for `.agent-atelier/.pending-tx.json`; if present, runs `state-commit --replay`.
- `tests/all.sh` — full suite from upstream, ported to TS where possible (`tests/schema_validation.ts`, `tests/mutation_flow.ts`, etc.). Subagent tests stub-spawn a fake `pi` binary that emits canned JSON.
- **`monitors` rewrite as pi child processes** — real implementation:
  - `src/commands/monitors.ts` (replace stub) — `spawn`, `status`, `stop` subcommands manage child processes via `pi.exec` with `{ background: true }` (or `child_process.spawn` directly with PID tracking in `.agent-atelier/watchdog-jobs.json`).
  - For each upstream monitor (`heartbeat-watch`, `gate-watch`, `event-tail`, `ci-status`, `branch-divergence`): port the polling loop from bash to a small TS helper that reads state files / runs git commands, sleeps, and writes events to `.agent-atelier/events.ndjson`. Output streamed back via `setWidget` updates rather than terminal `Monitor` semantics.
  - Stop on `session_shutdown` event (kill all spawned monitor PIDs).
  - +1 day to v1 timeline (per user decision).
- README install instructions: **git-clone + symlink** (matches pi example pattern):
  ```
  mkdir -p ~/.pi/agent/extensions/agent-atelier
  ln -sf "$(pwd)/src/index.ts" ~/.pi/agent/extensions/agent-atelier/index.ts
  # bundled agents/, prompts/, scripts/, schema/, references/ are loaded relative to import.meta.url
  ```
  npm package deferred (post-v1).

**Verify (end-to-end):**
1. Fresh empty git repo.
2. Install per README, `pi --extension <path>` loads cleanly.
3. `/aa-init`, `/aa-wi upsert` → simple WI cycles to `done`.
4. `/aa-wi upsert` → complex WI: builder-plan → confirm dialog → builder → done.
5. Kill-9 mid-`state-commit`; restart pi; recovery replays the WAL on `session_start`.
6. `bash tests/all.sh` reports all green.

## Reuse map (existing utilities — do not rewrite)

From upstream `ether-moon/agent-atelier` (path under `plugins/agent-atelier/`):
- `scripts/state-commit` (Python ~22KB; sole-writer, fcntl-locked) — verbatim, called via `pi.exec`.
- `scripts/build-vrm-prompt` (Python; reads `work-items.json`, validates against schema) — verbatim.
- `schema/vrm-evidence-input.schema.json` — verbatim.
- `references/{paths,state-defaults,wi-schema,recovery-protocol,success-metrics-routing}.md` — verbatim.
- `references/prompts/*.md` — 10 verbatim, only `orchestrator.md` adapted in Phase 4.
- `.claude/agents/*.md` frontmatter — adapted (tool/model normalization only; bodies are `@`-includes that we replace with the literal `prompts/<name>.md` path resolved at agent load).
- `hooks/on-pre-tool-use.sh` regex blocklist → `src/lib/destructiveCommands.ts`.
- `hooks/on-prompt.sh` JSON output logic → `src/events/input.ts` context-line builder.
- `tests/all.sh` and sub-runners → `tests/all.sh` (ported, scoped to extension).

From `badlogic/pi-mono` examples (vendor with attribution in source comments):
- `examples/extensions/subagent/agents.ts` (`parseFrontmatter`, `loadAgentsFromDir`, `discoverAgents`, `formatAgentList`) → `src/subagents/agents.ts`. Adapted to load from a bundled directory.
- `examples/extensions/subagent/index.ts` (`runSingleAgent`, `mapWithConcurrencyLimit`, `getPiInvocation`, `writePromptToTempFile`, the three execution modes) → `src/subagents/{spawn.ts, tool.ts}`. Adapted: tool name `aa-subagent`, agents from bundled dir, no project-scope confirmation prompt.
- `examples/extensions/plan-mode/utils.ts` (`isSafeCommand`, `DESTRUCTIVE_PATTERNS`, `SAFE_PATTERNS`) → `src/lib/safeBash.ts`. Used in Phase 5 union with our destructive-command blocklist.

## Resolved decisions (locked in before Phase 1)

1. **Subagent code: vendor.** Copy pi `examples/extensions/subagent/{index,agents}.ts` (~1000 LOC) into `src/subagents/{spawn,agents,tool}.ts`. Self-contained, no external install required, decoupled from upstream changes. Preserve attribution comments at the top of each vendored file.
2. **Distribution: git-clone + symlink.** Per pi example pattern. Documented in README. npm package deferred (post-v1).
3. **`monitors`: real implementation in Phase 6** (not a stub). Rewrite as pi child processes managed by `src/commands/monitors.ts`. Adds ~1 day to v1 timeline.
4. **pi version pin.** Pin `@mariozechner/pi-coding-agent` to a tested commit SHA in `package.json` (snapshot at port-start time, recorded in README).

## End-to-end verification (post-Phase 6)

```
# 1. fresh repo
mkdir /tmp/atelier-smoke && cd /tmp/atelier-smoke && git init

# 2. extension loads
pi --extension /path/to/agent-atelier-pi-extension/src/index.ts

# 3. inside pi REPL
/aa-init
/aa-status                                        # mode: DISCOVER, no gates
/aa-wi upsert {"id":"WI-001","title":"hello","complexity":"simple",...}
/aa-run
# observe: orchestrator → architect → builder → done; widget refreshes

/aa-wi upsert {"id":"WI-002","title":"complex","complexity":"complex",...}
/aa-run
# observe: orchestrator → architect → builder-plan → ExitPlanMode dialog → approve → builder → done

# 4. tests
bash tests/all.sh
```

All four steps green ⇒ v1 done.
