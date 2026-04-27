# Design: agent-atelier as a pi-coding-agent extension

This document describes how the agent-atelier orchestration loop is reshaped to run as a single pi-coding-agent extension. It complements [`mapping.md`](mapping.md) (component-by-component table) and [`roadmap.md`](roadmap.md) (phased delivery plan).

## 1. Goals and non-goals

**Goals**

- Preserve the orchestration model verbatim: state machine, work item lifecycle, candidate-set fate-sharing, gate criteria, validation evidence contract.
- Preserve operational artifacts: subagent definitions, role prompts, schemas, the `state-commit` script.
- Adapt only the host-specific surfaces: skill registration, hook events, native task integration, plan approval mechanics.
- Result must be installable as a single pi extension with no Claude Code dependency.

**Non-goals**

- Rewriting the role prompts or rebalancing responsibilities between roles.
- Redesigning the work item schema or lifecycle.
- Supporting both Claude Code and pi from one codebase. The upstream agent-atelier remains the Claude Code home; this repository is pi-only.
- Achieving feature parity with Claude Code's native `TaskCreate`/`Update`/`List` UI. We replace it with a pi widget that reads from `work-items.json`.

## 2. Constraints

- pi has **no description-based skill auto-trigger**. Commands are invoked explicitly (`/name`) or by the agent reading a referenced doc and calling them. The orchestrator role prompt must therefore be more prescriptive about when to invoke each command.
- pi has **no MCP**. agent-atelier does not currently rely on MCP, so this is fine. Future additions that would have used MCP must instead become extension-registered tools or external CLIs invoked through `pi.exec`.
- Subagents in pi are **isolated processes**. Inter-agent communication is mediated by the orchestrator session. This matches the existing model.
- The extension runs with **full system permissions**. Any destructive guardrails (e.g., the existing `on-pre-tool-use.sh` blocker) must be re-implemented inside the extension.

## 3. Architecture overview

The extension is a single TypeScript module exporting a default `(pi: ExtensionAPI) => void` factory. Inside, it composes four layers:

```
┌──────────────────────────────────────────────────────────────┐
│  agent-atelier-pi-extension (TypeScript module)              │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │   Commands   │  │   Events     │  │   State bridge     │ │
│  │ (pi.register │  │ (pi.on(...)) │  │ (Bash via pi.exec) │ │
│  │  Command)    │  │              │  │                    │ │
│  └──────┬───────┘  └──────┬───────┘  └─────────┬──────────┘ │
│         │                 │                     │             │
│         └────────┬────────┴─────────────────────┘             │
│                  │                                             │
│         ┌────────▼─────────┐                                  │
│         │   Subagent layer │  (markdown definitions in        │
│         │                  │   ./agents/, loaded by extension)│
│         └──────────────────┘                                  │
└──────────────────────────────────────────────────────────────┘
                             │
                             ▼
                ┌──────────────────────────┐
                │  .agent-atelier/         │  (runtime state, gitignored)
                │  ├── loop-state.json     │
                │  ├── work-items.json     │
                │  └── watchdog-jobs.json  │
                └──────────────────────────┘
```

**Layers**

1. **Commands** — One pi command per agent-atelier skill. Handlers parse subcommands and arguments, then either mutate state via the state bridge or render output to `ctx.ui`.
2. **Events** — pi event handlers replacing the seven Claude Code hooks. They enforce destructive-command blocking, gate prompts on session start, and react to agent lifecycle.
3. **State bridge** — A thin TypeScript wrapper around `pi.exec("bash", ["plugins/.../state-commit", ...])`. The bridge does not write JSON directly; the bash script remains the sole writer to preserve atomicity guarantees.
4. **Subagent layer** — The extension discovers and registers the seven role markdown files at startup, exposing them through pi's subagent mechanism. The orchestrator dispatches via the spawn primitive provided by pi's subagent extension pattern.

## 4. Module / file layout (proposed)

```
agent-atelier-pi-extension/
├── README.md
├── LICENSE
├── .gitignore
├── package.json                 # Node + TS package metadata, single dependency on @mariozechner/pi-coding-agent
├── tsconfig.json
├── src/
│   ├── index.ts                 # default export — extension factory
│   ├── commands/                # one file per pi command
│   │   ├── wi.ts
│   │   ├── status.ts
│   │   ├── execute.ts
│   │   ├── candidate.ts
│   │   ├── validate.ts
│   │   ├── gate.ts
│   │   ├── watchdog.ts
│   │   ├── monitors.ts
│   │   ├── init.ts
│   │   └── run.ts
│   ├── events/                  # event handlers
│   │   ├── input.ts             # was on-prompt.sh
│   │   ├── toolCall.ts          # was on-pre-tool-use.sh + plan-mode interception
│   │   ├── agentEnd.ts          # was on-stop.sh + on-task-completed.sh + teammate-idle bits
│   │   └── sessionStart.ts      # bootstrapping checks (was implicit in plugin load)
│   ├── state/                   # state bridge
│   │   ├── stateCommit.ts       # wraps the bash script
│   │   ├── workItems.ts         # read-side helpers over work-items.json
│   │   ├── loopState.ts         # read-side helpers over loop-state.json
│   │   └── watchdogJobs.ts      # read-side helpers over watchdog-jobs.json
│   ├── subagents/
│   │   └── registrar.ts         # discovers ./agents/*.md and registers with pi
│   ├── ui/
│   │   └── widgets.ts           # ctx.ui.setWidget renderers (replaces native task UI)
│   └── lib/
│       ├── paths.ts             # mirrors references/paths.md
│       ├── argparse.ts          # shared <verb> [args...] parser used by every command
│       ├── tools.ts             # Claude → pi tool name mapping (single source of truth)
│       └── types.ts             # WI status enum, lease shape, etc.
├── agents/                      # subagent markdown definitions (ported from .claude/agents/)
│   ├── architect.md
│   ├── builder.md
│   ├── builder-plan.md          # restricted variant for plan mode (added in Phase 5)
│   ├── pm.md
│   ├── qa-reviewer.md
│   ├── state-manager.md
│   ├── ux-reviewer.md
│   └── vrm.md
├── prompts/                     # role prompt bodies (ported from references/prompts/)
│   ├── orchestrator.md
│   ├── architect.md
│   ├── builder.md
│   ├── pm.md
│   ├── qa-reviewer.md
│   ├── state-manager.md
│   ├── ux-reviewer.md
│   ├── vrm.md
│   ├── ui-designer.md
│   ├── aesthetic-ux-reviewer.md
│   └── output-discipline.md
├── scripts/                     # bash scripts ported as-is
│   ├── state-commit
│   ├── build-vrm-prompt
│   └── monitors
├── schema/
│   └── vrm-evidence-input.schema.json
├── references/                  # static reference docs (ported from plugin)
│   ├── paths.md
│   ├── state-defaults.md
│   ├── wi-schema.md
│   ├── recovery-protocol.md
│   └── success-metrics-routing.md
├── tests/
│   └── all.sh                   # ported test entry, scoped to extension
└── docs/
    ├── design.md                # this document
    ├── mapping.md
    └── roadmap.md
```

## 5. Lifecycle and event flow

A typical orchestrator session:

```
session_start
  └─ extension registers commands, events, subagents
  └─ sessionStart.ts checks .agent-atelier/ exists; offers /init if not

input (user types "run the loop")
  └─ orchestrator role prompt is the active system prompt
  └─ orchestrator decides to call /status, sees pending WI

agent_start (orchestrator)
  ├─ tool_call: spawn subagent (architect for BUILD_PLAN)
  │   └─ toolCall.ts: in plan-mode, restrict to read-only tools
  ├─ subagent runs in isolated process
  ├─ subagent emits ExitPlanMode → ctx.ui.confirm()
  ├─ on approval, restrictions lift, builder spawn for IMPLEMENT
  └─ agent_end (subagent)
      └─ agentEnd.ts: update WI lease, fire orchestrator next step

orchestrator continues until DONE or gate
  └─ on gate: gate.ts opens HDR, blocks until /gate resolve
  └─ on DONE: loopReport via setWidget
```

**Key event responsibilities**

| pi event | Handler responsibility |
|---|---|
| `session_start` | Bootstrap check: `.agent-atelier/` exists, watchdog jobs sane, offer recovery if mid-transaction |
| `input` | Inject prompt-time reminders (e.g., active human gates), equivalent to the existing UserPromptSubmit hook |
| `tool_call` | (a) Block destructive commands per allowlist; (b) when in plan mode, restrict to read-only tool set; (c) emit confirm dialog for `ExitPlanMode` |
| `agent_end` | Update WI lease/status, mark candidate progress, trigger orchestrator follow-up |
| `tool_result` | Capture artifact paths for verification; equivalent to the existing TaskCompleted hook |
| `before_provider_request` | (Optional) inject prompt cache markers; not on the critical path for v1 |

## 6. Subagent porting strategy

Source: `.claude/agents/*.md` (7 files in upstream).

**Frontmatter mapping**

| Claude Code field | pi subagent field | Notes |
|---|---|---|
| `name` | `name` | identical |
| `description` | `description` | identical |
| `tools` | `tools` | enum names differ; need a small lookup table (e.g., `Read,Edit,Write,Bash,Grep,Glob` → `read,edit,write,bash,grep,find`) |
| `model` | `model` | aliases need normalization (`opus`, `sonnet`, `haiku` → pi's model identifiers) |

**Body**

The body of each agent file references a role prompt under `references/prompts/`. In pi we keep this convention by colocating prompts under `./prompts/` and using a relative-path include marker that the subagent registrar resolves at load time.

**Plan mode signaling**

The Architect sets a `complexity` field on the work item. The orchestrator reads this when spawning the Builder and chooses between two registered subagent variants:

- `builder-plan` — restricted toolset, expects `ExitPlanMode` before completion
- `builder` — full toolset, immediate implementation

This avoids needing a per-spawn permission override (which pi does not expose directly) by encoding the mode into agent identity.

## 7. Skill → command porting strategy

Source: 10 skills under `plugins/agent-atelier/skills/`.

**Naming**

Pi commands are flat (no namespace). To avoid colliding with future installed extensions, all commands use the prefix `aa-` (e.g., `/aa-status`, `/aa-wi`). The leading prefix is short to keep typed invocations fast.

**Subcommand handling**

Several skills have subcommands (e.g., `wi list`, `wi show <id>`, `wi upsert`). Each pi command parses its own argument string. A small shared parser in `lib/argparse.ts` handles the common shape `<verb> [args...]`.

**Auto-trigger workaround**

Where the upstream skill description triggered automatic invocation, the orchestrator role prompt now lists the trigger phrases and the corresponding command. Example:

> When you observe a stale lease (heartbeat > threshold), invoke `/aa-watchdog scan` before continuing.

This shifts cognitive load from the runtime to the prompt — acceptable because the orchestrator already reads the role prompt every session.

## 8. Hook → event porting strategy

Source: 7 hook scripts under `plugins/agent-atelier/hooks/`.

**Mapping**

| Claude Code hook | pi event | Migration notes |
|---|---|---|
| `UserPromptSubmit` (`on-prompt.sh`) | `input` | Direct port; same: append context lines about active gates, frozen items |
| `PreToolUse` (`on-pre-tool-use.sh`) | `tool_call` | Direct port; return `{ block: true, reason }` to refuse |
| `Stop` (`on-stop.sh`) | `agent_end` (orchestrator) | Triggers final state-flush |
| `SubagentStop` | `agent_end` (subagent) | Distinguished by which agent's lifecycle ended |
| `TaskCompleted` (`on-task-completed.sh`) | `tool_result` | Inspect tool result for artifact paths |
| `TaskCreated` (`on-task-created.sh`) | (none — replaced by `wi upsert` flow) | The native task tool is gone, so creation hook is unnecessary |
| `TeammateIdle` (`on-teammate-idle.sh`) | `agent_end` + custom queue | Re-implement the auto-assignment scan in TS |

**Bash → TypeScript**

Existing scripts are short (averaging ~30 LOC). They will be re-implemented in TS rather than wrapped, because:

- They mostly read JSON and decide whether to print context
- Wrapping bash adds latency on every event (bad for `tool_call` which fires on every tool invocation)
- TS port enables strong typing of the WI shape

The `state-commit` and `build-vrm-prompt` scripts are exceptions: they're the sole-writer atomic store, and the file-locking semantics are easier to keep correct in bash. Those remain bash, called via `pi.exec`.

## 9. State management

**File layout** (under `.agent-atelier/`)

Unchanged from upstream:

- `loop-state.json` — control plane: mode, active candidate set, open gates
- `work-items.json` — WI store: per-WI status, lease, promotion history, completion
- `watchdog-jobs.json` — timeout thresholds and operating budgets

**Sole-writer guarantee**

The `state-commit` bash script is the only process allowed to mutate these files. The TS state bridge always invokes it via `pi.exec`. Direct `fs.writeFile` to these paths is forbidden by convention; a lint rule will enforce it.

**Reads**

Reads are direct file reads from TS. The bridge memoizes parsed contents within a single command/event handler invocation, then discards (no cross-handler cache, to avoid stale reads after a state-commit).

## 10. Plan approval flow

Modeled after pi's `plan-mode` example:

1. The Architect sets `complexity: "complex"` on the work item.
2. The orchestrator dispatches the `builder-plan` subagent variant. This variant has a restricted toolset (`read`, `bash` allowlisted to `git`/`grep`/`ls`/etc., `find`, `grep`).
3. The `tool_call` event handler enforces the restriction by rejecting any tool not in the allowlist with `{ block: true, reason: "plan mode" }`.
4. The Builder produces a numbered plan and calls a registered `ExitPlanMode` tool.
5. The `ExitPlanMode` handler triggers `ctx.ui.confirm("Approve plan?", planText)`.
6. On approval, the orchestrator records approval on the WI and respawns the Builder as the unrestricted `builder` variant (because pi cannot dynamically grant tools to a running agent).
7. On rejection, the orchestrator either requests a revision (re-spawn `builder-plan` with feedback) or marks the WI as blocked.

The respawn-on-approval design loses the in-context continuity that Claude Code's `bypassPermissions` transition gave for free. The trade-off is acceptable because:

- The plan text plus rejection feedback is short enough to refit into the implementation spawn's context
- It removes ambiguity about which mode the agent is currently in
- It composes with pi's session fork primitive: the unrestricted spawn can be `ctx.fork`-ed from the plan-mode session, which carries the conversation history forward even though the live process is replaced

## 11. Removed: native task integration

The upstream plugin syncs `work-items.json` to Claude Code's native `TaskList` for visibility and dependency resolution. AGENTS.md already states `work-items.json` is the source of truth and the sync is best-effort.

In pi, this sync is dropped:

- **Source of truth** — `work-items.json` directly (no change)
- **Visibility** — a `ctx.ui.setWidget` rendering the active WI list, refreshed on each `agent_end` and `tool_result`
- **Dependency resolution** — already implemented in `state-commit` (it computes ready/blocked transitions); the widget just displays the result

## 12. Open questions and risks

1. **Subagent spawn API stability** — pi's subagent extension is example-only, not part of the documented core API surface. If the API shape changes, our subagent registrar must follow.
2. **Tool name normalization** — the Claude → pi tool name mapping (`Bash` → `bash`, `Edit` → `edit`, etc.) is small but version-sensitive. We need a single source of truth in `lib/tools.ts`.
3. **`monitors` script portability** — the upstream `monitors` script uses `Monitor` tool semantics specific to Claude Code. The closest pi primitive is `pi.exec` with backgrounded processes, which has different output streaming semantics. May require a meaningful rewrite, not just a port.
4. **Concurrency model** — Claude Code's Agent Teams can run multiple subagents in parallel turns. pi's subagents run as separate processes, but the orchestration of which run when (the candidate-set fate-sharing slot) lives entirely in our extension code. We must verify that two simultaneously-spawned subagents do not race on the lease or the state-commit lock.
5. **Auto-trigger on description** — the workaround (more prescriptive orchestrator prompt) is untested at scale. If it degrades reliability, we may need a custom `input` handler that pattern-matches user phrases against skill descriptions and suggests commands.
6. **Distribution** — pi extensions are TS files loaded via `--extension <path>` or auto-discovery from `~/.pi/agent/extensions/`. Bundling agents/, prompts/, and scripts/ alongside the TS module needs a clear install story (npm package vs. git clone).

These are tracked for resolution during implementation; none block the phased plan in [`roadmap.md`](roadmap.md).
