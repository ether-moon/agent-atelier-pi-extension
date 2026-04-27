# agent-atelier-pi-extension

A port of [agent-atelier](https://github.com/ether-moon/agent-atelier) — an autonomous product development loop with a multi-agent team — to a [pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension.

> **Status:** Design phase. No code yet. See [`docs/design.md`](docs/design.md), [`docs/mapping.md`](docs/mapping.md), and [`docs/roadmap.md`](docs/roadmap.md).

## What this is

agent-atelier is a Claude Code plugin that drives a fixed team of subagents (PM, Architect, Builder, VRM, QA, UX, State-Manager) through a state machine — `DISCOVER → BUILD_PLAN → IMPLEMENT → CANDIDATE_VALIDATE → REVIEW → DONE` — with explicit gates for human decisions. It maintains its own runtime state in `.agent-atelier/` and uses a sole-writer `state-commit` script for atomic multi-file writes.

This repository is the design and (eventually) implementation of the same loop as a pi-coding-agent extension. The goal is to keep the orchestration model and operational artifacts identical while adapting the surrounding mechanisms (skills, hooks, native task integration) to pi's API surface.

## Why pi

pi exposes a richer set of orchestration primitives than what agent-atelier currently uses through Claude Code:

- **Programmatic session control** — `ctx.newSession`, `ctx.fork`, `ctx.switchSession`, `ctx.navigateTree`
- **Mid-flight steering** — `pi.sendMessage({ deliverAs: "steer" | "followUp" | "nextTurn" })` lets the orchestrator inject guidance into a running subagent
- **Explicit subagent pattern** — markdown definitions with YAML frontmatter, isolated processes, per-agent model selection (mirrors agent-atelier's existing `.claude/agents/` shape)
- **Reference plan-mode extension** — a working pattern for tool restriction + approval that maps cleanly onto agent-atelier's `mode: "plan"` flow
- **Rich event lifecycle** — 28+ events covering session, agent, turn, tool, and provider phases

## What stays the same

- The 7 subagent role definitions (PM, Architect, Builder, VRM, QA, UX, State-Manager)
- The 11 role prompts in `references/prompts/`
- The work item schema, lifecycle, and `.agent-atelier/` state file layout
- The `state-commit` and `build-vrm-prompt` scripts (called by the extension via `pi.exec`)
- The orchestration state machine and the candidate-set fate-sharing semantics

## What changes

- Skills become pi commands (`/wi`, `/status`, `/execute`, …)
- Hooks become pi event handlers (`pi.on("input", …)`, `pi.on("tool_call", …)`, `pi.on("agent_end", …)`)
- Native `TaskCreate`/`TaskUpdate` integration is dropped — `work-items.json` is sole source of truth (already the documented contract upstream); native task UI is replaced by `ctx.ui.setWidget`
- Plan approval flow is implemented via `tool_call` interception, modeled after pi's `plan-mode` example

## Roadmap

See [`docs/roadmap.md`](docs/roadmap.md) for the phased plan. The current scope of this repository is **design documentation only** — implementation will follow once the design is reviewed.

## License

MIT — see [LICENSE](LICENSE).

## References

- Upstream: [agent-atelier](https://github.com/ether-moon/agent-atelier)
- Host runtime: [pi-mono / coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)
- pi extensions API: [extensions.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- pi subagent example: [examples/extensions/subagent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/subagent)
- pi plan-mode example: [examples/extensions/plan-mode](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions/plan-mode)
