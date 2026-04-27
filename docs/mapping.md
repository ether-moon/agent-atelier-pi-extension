# Component Mapping: agent-atelier → pi extension

A component-by-component mapping of every artifact in the upstream `plugins/agent-atelier/` plugin to its target in this repository. Cross-reference [`design.md`](design.md) for rationale.

## Skills → pi commands

Upstream: `plugins/agent-atelier/skills/<name>/SKILL.md` (Markdown skill with frontmatter, optional subcommands).
Target: `src/commands/<name>.ts` (`pi.registerCommand`).

| Upstream skill | pi command | Subcommands kept | Notes |
|---|---|---|---|
| `init` | `/aa-init` | (none) | Bootstraps `.agent-atelier/` if missing. Idempotent. |
| `status` | `/aa-status` | (none) | Reads three state files, renders dashboard via `ctx.ui.setWidget` + text echo. |
| `wi` | `/aa-wi` | `list`, `show`, `upsert` | Source of truth for backlog mutations. `upsert` calls `state-commit`. |
| `execute` | `/aa-execute` | `claim`, `heartbeat`, `requeue`, `complete`, `record-attempt` | Lease lifecycle. Heartbeat is also called from a periodic `agent_end` handler. |
| `candidate` | `/aa-candidate` | `enqueue`, `activate`, `clear` | Candidate-set fate-sharing slot management. |
| `validate` | `/aa-validate` | (none) | Records VRM run manifest. Calls `build-vrm-prompt` script. |
| `gate` | `/aa-gate` | `list`, `open`, `resolve` | Human Decision Record (HDR) lifecycle. |
| `watchdog` | `/aa-watchdog` | `scan`, `recover` | Stale lease detection, budget enforcement. |
| `monitors` | `/aa-monitors` | `spawn`, `status`, `stop` | Background monitor lifecycle. See design.md §12 risk #3. |
| `run` | `/aa-run` | (none) | The orchestrator entry point. Sets the orchestrator system prompt, reads loop state, kicks off. |

10 skills total. All preserve their argument grammar from the upstream `SKILL.md` Subcommands sections.

## Hooks → pi events

Upstream: `plugins/agent-atelier/hooks/*.sh` registered through `hooks.json`.
Target: `src/events/*.ts` registered through `pi.on(...)`.

| Upstream hook | pi event | TS handler | Behavior preserved |
|---|---|---|---|
| `UserPromptSubmit` (`on-prompt.sh`) | `input` | `events/input.ts` | Inject context lines about active gates, frozen items, knowledge vault entries |
| `PreToolUse` (`on-pre-tool-use.sh`) | `tool_call` | `events/toolCall.ts` | Block destructive shell commands; enforce plan-mode tool allowlist |
| `Stop` (`on-stop.sh`) | `agent_end` (orchestrator turn) | `events/agentEnd.ts` | Final state-flush, dangling-obligation check |
| `SubagentStop` | `agent_end` (subagent turn) | `events/agentEnd.ts` | Update WI lease, fire orchestrator next-step |
| `TaskCompleted` (`on-task-completed.sh`) | `tool_result` | `events/toolCall.ts` (same file) | Capture artifact paths from tool result |
| `TaskCreated` (`on-task-created.sh`) | (removed) | — | Native task tool dropped; creation flows through `/aa-wi upsert` instead |
| `TeammateIdle` (`on-teammate-idle.sh`) | `agent_end` + queue scan | `events/agentEnd.ts` | After subagent finishes, scan for next-claimable WI and dispatch |

7 upstream hooks. 6 retained, 1 removed.

## Subagents → pi subagent definitions

Upstream: `.claude/agents/*.md` (7 files, frontmatter declares model/tools).
Target: `agents/*.md` in this repository, registered at extension load time.

| Upstream agent | Target | Frontmatter changes |
|---|---|---|
| `state-manager.md` | `agents/state-manager.md` | tool name normalization; model alias |
| `pm.md` | `agents/pm.md` | same |
| `architect.md` | `agents/architect.md` | same |
| `builder.md` | `agents/builder.md` | **plus** a sibling `agents/builder-plan.md` with restricted toolset (see design.md §10) |
| `vrm.md` | `agents/vrm.md` | same |
| `qa-reviewer.md` | `agents/qa-reviewer.md` | same |
| `ux-reviewer.md` | `agents/ux-reviewer.md` | same |

7 upstream agents → 8 target agents (Builder split into `builder` and `builder-plan`).

## Role prompts

Upstream: `plugins/agent-atelier/references/prompts/*.md` (11 files).
Target: `prompts/*.md` (verbatim, except orchestrator).

| Prompt | Target | Changes |
|---|---|---|
| `orchestrator.md` | `prompts/orchestrator.md` | Augmented with explicit command names (`/aa-status`, `/aa-wi list`, etc.) replacing implicit skill invocations. Plan Review Protocol section adapted for the respawn-on-approval flow. |
| `state-manager.md` | `prompts/state-manager.md` | Verbatim |
| `pm.md` | `prompts/pm.md` | Verbatim |
| `architect.md` | `prompts/architect.md` | Verbatim. Still sets `complexity` field — still drives Builder variant selection. |
| `builder.md` | `prompts/builder.md` | Verbatim |
| `vrm.md` | `prompts/vrm.md` | Verbatim |
| `qa-reviewer.md` | `prompts/qa-reviewer.md` | Verbatim |
| `ux-reviewer.md` | `prompts/ux-reviewer.md` | Verbatim |
| `aesthetic-ux-reviewer.md` | `prompts/aesthetic-ux-reviewer.md` | Verbatim |
| `ui-designer.md` | `prompts/ui-designer.md` | Verbatim |
| `output-discipline.md` | `prompts/output-discipline.md` | Verbatim |

11 upstream prompts → 11 target prompts. Only `orchestrator.md` changes.

## Scripts

Upstream: `plugins/agent-atelier/scripts/*` (3 files).
Target: `scripts/*` (kept as bash, called via `pi.exec`).

| Script | Target | Status |
|---|---|---|
| `state-commit` | `scripts/state-commit` | Verbatim. Sole writer for state files. |
| `build-vrm-prompt` | `scripts/build-vrm-prompt` | Verbatim. Builds VRM evidence input from schema. |
| `monitors` | `scripts/monitors` | **Likely rewrite.** Depends on Claude Code's `Monitor` tool semantics. May become a TS module using `pi.exec` with child process management. See design.md §12 risk #3. |

## Schema

| Upstream | Target | Changes |
|---|---|---|
| `schema/vrm-evidence-input.schema.json` | `schema/vrm-evidence-input.schema.json` | Verbatim |

## References

Upstream: `plugins/agent-atelier/references/*.md` (5 files, excluding the prompts/ subdirectory).
Target: `references/*.md` (verbatim).

| Reference | Target |
|---|---|
| `paths.md` | `references/paths.md` |
| `state-defaults.md` | `references/state-defaults.md` |
| `wi-schema.md` | `references/wi-schema.md` |
| `recovery-protocol.md` | `references/recovery-protocol.md` |
| `success-metrics-routing.md` | `references/success-metrics-routing.md` |

`paths.md` may need updates if file locations differ; everything else is content-only and copies cleanly.

## Native Task tool integration

Upstream: `TaskCreate`/`TaskUpdate`/`TaskList` synced from `work-items.json` (best-effort).

Target: **removed.** Replaced by `ctx.ui.setWidget` rendering of the WI list. See design.md §11.

## Tests

Upstream: `tests/all.sh` (entry point that runs unit tests for state-commit, schema validation, etc.).
Target: `tests/all.sh` (ported, scoped to this repo's components only). Tests that exercised Claude Code-specific behavior are dropped or replaced with extension-level tests.

## Settings (`hooks.json`, `.claude/settings.json`)

Upstream: project-level hooks declared in JSON, plus `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
Target: **removed.** All hook registration and configuration happens inside the TS extension factory. No JSON settings file needed.

## Summary table

| Category | Upstream count | Target count | Verbatim | Adapted | Removed | Added |
|---|---|---|---|---|---|---|
| Skills/Commands | 10 | 10 | 0 | 10 | 0 | 0 |
| Hooks/Events | 7 | 6 | 0 | 6 | 1 | 0 |
| Subagents | 7 | 8 | 0 | 7 | 0 | 1 (`builder-plan`) |
| Role prompts | 11 | 11 | 10 | 1 (`orchestrator.md`) | 0 | 0 |
| Scripts | 3 | 3 | 2 | 1 (`monitors`) | 0 | 0 |
| Schema | 1 | 1 | 1 | 0 | 0 | 0 |
| References | 5 | 5 | 5 | 0 | 0 | 0 |
| Native Task integration | 1 | 0 | 0 | 0 | 1 | 0 |
| Settings JSON | 2 | 0 | 0 | 0 | 2 | 0 |
| Extension entry (TS) | 0 | 1 | 0 | 0 | 0 | 1 |
| State bridge | 0 | 1 module | 0 | 0 | 0 | 1 |
| UI widgets | 0 | 1 module | 0 | 0 | 0 | 1 |

**Net:** Of 47 trackable artifacts upstream, 18 carry over verbatim, 25 are adapted, 4 are removed, and 3 new modules are introduced.
