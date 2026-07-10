# Agent Skill Authoring — Token-Efficient Standard

How to write PSD agent skills (`infra/agent-image/skills/<name>/SKILL.md`) so we can
add **dozens** of skills without growing the model's per-call cost. Read this before
adding a skill.

## Why this matters (the cost model)

Every model call in a turn re-reads the **system prompt** (the cached "prefix").
The agent makes ~5–20 model calls per turn, so **anything in the prefix is paid for
N times per turn**. Skills advertise into that prefix.

OpenClaw uses **progressive disclosure** ([docs](https://docs.openclaw.ai/tools/skills)):

- **Always loaded** into the system prompt: each skill's `name` + `description`,
  compiled into a compact block. This is the *only* per-skill cost that scales with
  skill count.
- **Loaded on-demand**: the full `SKILL.md` body — only when the model decides the
  skill is relevant and reads it.

**Consequence:** skill *count* is cheap **iff** descriptions are tight. A verbose
description is the one way a skill bloats every turn. At 26 skills, ~40-token
descriptions ≈ **1k** always-on tokens; ~150-token descriptions ≈ **4k**. At 100+
skills that gap is what re-reads on every model call.

## The one rule

> `description` is the only always-loaded, model-facing text. Keep it to **1–2
> sentences (~30–50 tokens)**. It must answer **what it does + when to use it
> (trigger words)**. Everything else goes in the body.

## Frontmatter contract (what OpenClaw actually reads)

| Field | Loaded into system prompt? | Use |
|-------|---------------------------|-----|
| `name` | ✅ always | kebab-case identifier |
| `description` | ✅ always | **tight** what + when (trigger words) |
| `allowed-tools` | no | advisory tool scope (e.g. `Bash(node:*)`) |
| `user-invocable`, `disable-model-invocation`, … | no | behavior flags |
| **`summary`** | **❌ not read by OpenClaw** | **required by the PSD skill catalog** (`psd-skills-meta`) — a one-line catalog entry. Keep it, but it never reaches the model. |

**`summary` vs `description` — two different audiences:**
- `summary` → the PSD skill **catalog** (a DB row via `psd-skills-meta`; validation
  *requires* it). One line. Not in the model prompt. **Keep it.**
- `description` → the **model's** system prompt (OpenClaw injects it on every turn).
  Tight + trigger-rich. **This is the one you optimize.**

Do **not** rely on `summary` for model triggering — OpenClaw ignores it. If a skill's
good trigger line lives only in `summary` (e.g. `chat-chart`'s "REQUIRED for
chart/graph/plot"), copy it into `description` so the model actually sees it.

## `description`: do / don't

```yaml
# ❌ mechanism belongs in the body — this is paid on every model call, every turn
description: Wraps the `gws` CLI. Fetches a refresh token from AWS Secrets Manager,
  exchanges it for an access token, and executes `gws` subcommands against Google
  APIs as the agent's own identity. If the token is stale it mints a consent URL and
  returns a structured error; paste the consent_url verbatim... [130+ tokens]

# ✅ what + when, ~35 tokens; the rest lives in the body (loaded only when used)
description: Google Workspace (Gmail, Calendar, Drive, Docs, Meet, Chat) as the
  user's agent account. Use for email, calendar, files, or Workspace lookups.
```

Checklist for a good `description`:
- One sentence of **what**, one short clause of **when/trigger words** the user would say.
- No API flows, secret names, S3 paths, envelope formats, capability gating, output shapes — **all body**.
- Written for the model deciding *whether to open this skill*, not for a human reading docs.

## Body best practices (the on-demand part)

The body is only loaded when the skill triggers, so detail here is "free" per-turn —
but keep it focused so the on-demand load is small and the model acts on the first read:

- **Lead with the exact invocation** the model runs (copy-paste command).
- State inputs, outputs, and the exit/error contract concretely.
- Put **large** reference content (full CLI surfaces, long schemas, big examples) in
  **separate files** the skill reads on demand, not inline in `SKILL.md`.
- 2–3 input→output examples beat prose.

## Copy-paste template

```markdown
---
name: my-skill
summary: <one line for the PSD skill catalog — required by psd-skills-meta>
description: <what it does in one sentence> + <when to use / trigger words>. Keep ~30–50 tokens.
allowed-tools: Bash(node:*)
---

# my-skill

<1–2 lines: what this is and the boundary/guarantee that matters.>

## Invoke

    node /opt/psd-skills/my-skill/run.js --user <caller-email> --command "..."

## Inputs / outputs / errors

- Input: ...
- Success (exit 0): ...
- Errors: exit N → ...

## Examples

    # <goal>
    node .../run.js --user a@b.org --command "..."   # → <result>
```

## Adding a skill — checklist

1. `description` is 1–2 sentences with trigger words; **no `summary`** field.
2. Mechanism/detail is in the body, not the description.
3. Large references are separate on-demand files.
4. Register deps in the consolidated skills `RUN` in the Dockerfile (do **not** add a
   new `RUN` layer — see the AgentCore overlay-mount ceiling note in the Dockerfile).
5. Rebuild + push the image; the new skill advertises at ~40 tokens.
