# Assistant Architect — Agentic Mode

> Issue #926 (Epic #922, workstream #4 — Unify Agent Platform)

Assistant Architect supports two runtime **modes**. An author chooses the mode
when creating or editing an assistant.

## The two modes

### Prompt-chain mode (default)

Form inputs → an ordered sequence of prompt templates run with one model →
text output. The model has **no autonomy**: it cannot call tools or decide what
to do next. Prompts execute by `position` (0, then 1, …); prompts at the same
position run in parallel.

This is the original Assistant Architect behavior and remains the default for
every existing and new assistant.

### Agentic mode

Form inputs → a **model loop with tool access** → output. The model decides
which tools to call, in what order, reasoning over each result, and continues
until the task is done or a run limit is hit. Tools come from the unified tool
catalog (#924) plus the author's per-user MCP connectors (#774), intersected
with the executing caller's scopes.

## When to use which

| Use **prompt-chain** when… | Use **agentic** when… |
| --- | --- |
| The workflow is fixed and predictable | The path depends on intermediate results |
| You want deterministic, repeatable output | The model needs to choose tools dynamically |
| No tool calls are needed (or only repository search per prompt) | The task needs catalog tools, MCP tools, web/doc/image tools |
| You want the simplest, cheapest execution | You accept higher cost for autonomy + tool use |

Start with prompt-chain. Move to agentic only when a fixed prompt sequence can't
express the task.

## Mode transitions

The transition is **one-way**: a prompt-chain assistant can be converted to
agentic, but an agentic assistant **cannot** be reverted to prompt-chain. The
editor locks the prompt-chain option once an assistant is agentic.

## Agentic configuration

When agentic mode is selected, the editor shows:

- **Tools** — a multi-select populated from the catalog's `internal` surface,
  filtered to tools that are `agentCallable` **and** the author's role-derived
  scopes permit. An author can only enable tools they could themselves invoke.
- **Max steps** — tool-use round-trips per run (1–50, default 10). Caps runaway
  loops.
- **Timeout** — wall-clock limit per run in seconds (1–900, default 300).
- **Cost cap** — per-run cost ceiling in USD (blank = no cap).

These persist on the `assistant_architects` row (`mode`, `agent_enabled_tools`,
`agent_enabled_connectors`, `agent_max_steps`, `agent_timeout_seconds`,
`agent_cost_cap_cents`; migration 082) and are DB CHECK-constrained.

## Security model — dual scope intersection

Tool access is intersected at **two** points:

1. **At authoring time** — the author can only add a tool their own scopes allow
   (`validateAgentTools` against the catalog `internal` surface).
2. **At execution time** — the *executing caller's* scopes are intersected again
   (`resolveAgentTools`), so a low-privilege user running an assistant an admin
   authored only gets the tools they personally have scope for.

Additional guards:

- `agent_callable: false` catalog tools are blocked unconditionally
  (`agentOnly` filter), even if listed.
- Tool resolution **fails closed**: an empty resolved set means the model gets
  no tools, never an unfiltered fallback.
- Every tool invocation is audited to `assistant_architect_events`
  (`tool-execution-complete`) with the tool identifier, args, success, duration,
  and the invoking principal.

## Runtime architecture

- **Tool resolver**: `lib/agents/tool-resolver.ts` — `resolveAgentTools()`
  merges catalog tools (each wrapped as an AI SDK tool that dispatches through
  `toolCatalogInstance.dispatch()`, the same in-process handler the MCP server
  uses) with per-user MCP connector tools. `closeAgentConnectorClients()` closes
  MCP clients in `onFinish`/`onError` (never a synchronous `finally`, so clients
  stay open while tool calls are in flight).
- **Run limits**: `lib/agents/limits.ts` — `resolveAgentRunLimits()` applies
  defaults and clamps to ceilings; `isCostCapExceeded()` gates further steps.
- **Execution**: `app/api/assistant-architect/execute/route.ts` branches on
  `architect.mode`. Agentic runs go through `executeAgenticAssistant()`, which
  streams via the unified streaming service with the pre-resolved `ToolSet` and
  `maxSteps` (so the AI SDK drives the loop and emits native tool-call parts).
- **Tool-call timeline**: the execution UI
  (`components/features/assistant-architect/tool-call-timeline.tsx`) renders the
  SSE tool-call lifecycle events the loop emits — one row per call with
  running / done / error status.

## References

- Catalog: `lib/tools/catalog/` (#924)
- MCP connectors: `lib/mcp/connector-service.ts` (#774)
- SSE events: `docs/features/assistant-architect-sse-events.md`
- Migration: `infra/database/schema/082-assistant-architect-agentic-mode.sql`
