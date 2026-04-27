# Roadmap

Phased delivery plan for porting agent-atelier to a pi extension. Each phase has a concrete acceptance criterion. Phases are ordered to minimize rework: assets that change least move first, the most uncertain pieces (subagent spawn, plan mode) move last.

The current scope of this repository is the design documents you are reading. Implementation begins after the design is reviewed.

## Phase 1 — Repo scaffold and asset mirror

**Goal:** Get the static, near-verbatim assets into the repo. No TypeScript yet.

- Create `package.json`, `tsconfig.json`, dependency on `@mariozechner/pi-coding-agent`.
- Copy `agents/` (7 files) from upstream `.claude/agents/`, normalize frontmatter (tool names, model aliases).
- Copy `prompts/` (11 files) from upstream `references/prompts/`. Adapt only `orchestrator.md` to reference `/aa-*` command names.
- Copy `scripts/` (`state-commit`, `build-vrm-prompt`) verbatim.
- Copy `schema/` and `references/`.
- Stub `src/index.ts` that exports a no-op factory, so the package is loadable.

**Acceptance:** `pi --extension ./src/index.ts` loads without error. No commands or agents are functional yet.

## Phase 2 — State bridge and read-only commands

**Goal:** Prove the bash-state-commit ↔ TS-bridge wiring works, without touching agents or events.

- Implement `src/state/stateCommit.ts` calling the bash script via `pi.exec`.
- Implement read helpers in `src/state/{workItems,loopState,watchdogJobs}.ts`.
- Implement read-only commands first: `/aa-status`, `/aa-wi list`, `/aa-wi show`, `/aa-gate list`.
- Implement `/aa-init` (writes state files via `state-commit`).

**Acceptance:** A user can `/aa-init` an empty directory, then `/aa-status` shows defaults. No subagents involved yet.

## Phase 3 — Mutating commands and event handlers

**Goal:** Full skill→command coverage and the easier hooks. Still no subagents.

- Implement remaining commands: `/aa-wi upsert`, `/aa-execute *`, `/aa-candidate *`, `/aa-validate`, `/aa-gate open|resolve`, `/aa-watchdog *`, `/aa-monitors *`, `/aa-run`.
- Implement event handlers: `events/input.ts`, `events/sessionStart.ts`, `events/toolCall.ts` (destructive-command blocker only — plan-mode comes in Phase 5).
- Port `tests/all.sh` minus subagent-dependent tests.

**Acceptance:** `bash tests/all.sh` passes for the non-subagent test set. A user can manually drive a WI from `pending` to `done` via commands.

## Phase 4 — Subagent layer

**Goal:** Get the seven role agents spawning under pi's subagent extension pattern.

- Study and pin pi's subagent example version. Vendor or wrap the spawn primitive.
- Implement `src/subagents/registrar.ts` that loads `agents/*.md` at extension boot and registers them.
- Implement `events/agentEnd.ts` to update WI lease state on subagent completion.
- Wire orchestrator dispatch: when `/aa-run` runs, it reads the role prompt and spawns subagents via the registered primitive.

**Acceptance:** A simple WI (no plan mode required) cycles through DISCOVER → BUILD_PLAN → IMPLEMENT → CANDIDATE_VALIDATE → REVIEW → DONE driven by subagents.

## Phase 5 — Plan approval flow

**Goal:** Restore the Architect→Builder plan-review handshake.

- Add the `agents/builder-plan.md` variant with restricted toolset.
- Extend `events/toolCall.ts` to enforce per-agent tool allowlists.
- Implement `ExitPlanMode` as a tool registered in `src/index.ts`. Its handler triggers `ctx.ui.confirm`.
- Implement the respawn-on-approval logic in the orchestrator dispatch path.

**Acceptance:** A `complexity: "complex"` WI spawns Builder in plan mode, the user approves the plan via the UI dialog, and Builder respawns with full tools to implement.

## Phase 6 — Stabilization

**Goal:** Production-ready.

- TaskCreate dependency removal verified (no code paths reference Claude Code task tools).
- Widget UI for active WI list, candidate slot, open gates.
- Recovery on session restart (replay interrupted transactions per `recovery-protocol.md`).
- End-to-end test: a small fixture WI runs the full loop, including a gate, in a CI environment.
- Distribution decision: npm package, git install, or auto-discovery folder. Ship instructions in README.

**Acceptance:** `bash tests/all.sh` passes in full. A first external install path is documented and verified.

## Out of scope (for now)

- Re-implementing `monitors` (Phase 1–6 work around it; full rewrite tracked as a follow-up).
- Auto-trigger by skill description (the orchestrator prompt workaround is the v1 strategy).
- Multi-host support (Claude Code + pi from one codebase). Upstream stays on Claude Code; this repo is pi-only.
- Parity with Claude Code's Agent Teams model beyond what's needed for the loop (e.g., richer inter-teammate messaging).
