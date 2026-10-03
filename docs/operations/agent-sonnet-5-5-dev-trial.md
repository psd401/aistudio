# Agent harness on Claude Sonnet 5.5 — dev trial checklist

The agent image's harness model moved from `us.anthropic.claude-sonnet-5` to
`us.anthropic.claude-sonnet-5-5` (Bedrock US cross-region inference profile).
This trial runs on **dev only**. Prod stays on Sonnet 5 until this checklist is
clean.

## What changed

| Where | Change |
|-------|--------|
| `infra/agent-image/openclaw.json` | Provider model + `agents.defaults.model.primary` → `us.anthropic.claude-sonnet-5-5` |
| `infra/agent-image/agentcore_wrapper.py` | `DEFAULT_AGENT_MODEL_ID` (telemetry fallback) |
| `infra/lib/agent-platform-stack.ts` | `BedrockChatModelInvoke` grants Sonnet 5.5 **and** Sonnet 5 (profile + 3 member regions each), so rolling back to a Sonnet 5 image digest needs no IAM deploy |
| `infra/database/schema/186-agent-sonnet-5-5-pricing.sql` | `ai_models` pricing rows for `us.anthropic.claude-sonnet-5-5` and `anthropic.claude-sonnet-5-5` — without them every turn prices at $0 (#1083) |
| `lib/agents/platform-model.ts` | Recorded/request id, aliases, cost-UI label |
| `infra/agent-image/eval/candidates/` | Baseline now composes the Sonnet 5.5 provider; `sonnet-5-native` kept as a model-axis candidate for side-by-side runs |

| `infra/agent-image/skills/psd-summarize/run.js` | Default `SUMMARIZE_MODEL_ID` → `us.anthropic.claude-sonnet-5-5` |
| `app/api/agent/model-proxy/[...path]/route.ts` | `ALLOWED_MODELS` admits Sonnet 5.5 **and** Sonnet 5 — the web app is shared, and prod's image still sends Sonnet 5 |

### Why no request-shaping changes were needed

Sonnet 5.5 rejects `thinking: {type: "disabled"}` and forced `tool_choice`
(`any` / `tool`) with a 400. Checked against the pinned OpenClaw
`2026.7.2-beta.5` host and Bedrock plugin:

- The host's `resolveClaudeSonnet5ModelIdentity` regex
  (`(?:^|-)claude-sonnet-5(?=$|[^a-z0-9])`) also matches `claude-sonnet-5-5`,
  so 5.5 gets the Sonnet 5 thinking profile: reasoning `off` maps to adaptive
  thinking at `low` effort. The plugin never sends `disabled`.
- When it sends adaptive thinking, the plugin rewrites `any` / `tool` tool
  choice to `auto` (`normalizeAdaptiveClaudeToolChoice`).
- Prompt caching: `supportsBedrockPromptCaching()` matches the
  `claude-sonnet-5` substring, so 5.5 is cached. `check_config_consistency.py`
  passes.
- `aws bedrock-runtime converse --model-id us.anthropic.claude-sonnet-5-5`
  from the account returned `end_turn` (2026-10-03).

### Known behavior differences to watch

- **Text between tool calls** now usually comes back as `thinking` blocks
  rather than `text`. Long multi-tool turns may look quieter in Chat.
- **Preserved thinking:** thinking blocks are bound to the conversation. The
  harness prunes context (`contextPruning: cache-ttl`) and compacts. Our
  account predates the 2026-08-31 enforcement cutoff, so an edited history
  should not 400 — but this is unverified on our traffic. Prompt 10 below
  exercises it.
- **Refusals:** Sonnet 5.5 declines in five categories (`cyber`, `bio`,
  `frontier_llm`, `reasoning_extraction`, `general_harms`). A decline is
  HTTP 200 with `stop_reason: "refusal"`, not an error.
- **Effort levels are recalibrated** — same names, different amount of
  thinking. Watch latency and output tokens per turn.

## Deploy order (dev)

1. Web app + database migration 186 — before the first 5.5 turn. Without the
   migration those turns record $0; without the web app, `psd-summarize` gets
   a 400 from the model proxy.
2. `AIStudio-AgentPlatformStack-Dev` (IAM grant).
3. Build and push the agent image; deploy it to dev by digest.

## The 10 prompts

Send each as a DM to a dev agent in Google Chat. Use a fresh thread unless the
prompt says otherwise. Record pass/fail, latency, and anything odd.

| # | Prompt | What it exercises | Pass looks like |
|---|--------|-------------------|-----------------|
| 1 | `What can you help me with? Give me a short list of the skills you have and one example request for each of three of them.` | Boot, bootstrap files, skill catalogue | Answers from the real skill list; no invented skills; reply arrives in one message |
| 2 | `What's on my calendar tomorrow, and which emails from the last 24 hours look like they need a reply from me?` | Google Workspace broker, two tool families in one turn | Real events and emails; no Workspace auth error; no silent stall between tool calls |
| 3 | `Find the most recent Google Doc in my Drive with "agenda" in the title and summarize it in five bullets. Link the doc.` | Drive search + file read | Correct doc, working link, five bullets |
| 4 | `Run my morning brief now.` | Morning Brief skill — the heaviest everyday payload | Full brief delivered; every section present; no truncation; turn finishes |
| 5 | `Every weekday at 7:30 AM, send me a one-line reminder to check my Open Adaptive District team space. Then list my schedules.` Follow up: `Delete that reminder.` | psd-schedules (DynamoDB + EventBridge) | Schedule created, listed, then deleted; list confirms it is gone |
| 6 | `Search the web for what three Washington school districts have published this year about staff AI guidance. Give me a short comparison table with links.` | Web search, synthesis, citations | Real districts with working links; nothing fabricated; table renders |
| 7 | `Help me write a build plan for the Open Adaptive District. Our goal is getting more 9th graders on track in math, our problem is that counselors spend hours rewriting schedule-change emails, and we want to try an AI Studio assistant.` | Updated OAD skill | Uses the current template (goal it serves, lead/scribe/sponsor, tools we'll try, a countable sign, one thing that must not get worse); links psd401.ai and the build plan form; mentions agnt_hagelk@psd401.net |
| 8 | `Make a one-page HTML explainer of the Open Adaptive District build cycle and publish it to my private Atrium collection.` | psd-html-artifact + psd-atrium publishing | Artifact renders; published privately; link works; content matches psd401.ai |
| 9 | Attach a photo of a whiteboard or a short PDF, then: `Turn this into a list of action items with owners and due dates.` | Image / attachment input | Reads the attachment; does not invent owners or dates that aren't there |
| 10 | `Write a detailed 1,500-word briefing on how our district could use AI to support MTSS.` Then, **in the same thread**: `Now cut that to three bullets for a principal.` Then: `What was the second bullet about, and which part of the long version did it come from?` | Long reply delivery (32,000-byte budget, #1845), session memory, preserved-thinking replay across turns | Long reply arrives whole; follow-ups reference the earlier turns correctly; no 400 / ValidationException on turns 2–3 |

## What to check after the run

- **Errors:** CloudWatch logs for the dev runtime — any Bedrock `ValidationException`
  mentioning `thinking`, `tool_choice`, or `block_binding`; any `AccessDenied`.
- **Refusals:** any turn that ended with `stop_reason: "refusal"`.
- **Cost:** `/admin/agents` cost view shows non-zero spend labelled
  "Claude Sonnet 5.5"; `agent_messages.model` = `us.anthropic.claude-sonnet-5-5`.
- **Caching:** `agent_messages.cache_read_input_tokens` > 0 on the second and
  later turns of a thread.
- **Latency / tokens:** compare against the same prompts on prod (Sonnet 5).

## Rollback

Redeploy the previous Sonnet 5 agent image digest to dev. The IAM grant and
pricing rows cover both models, so nothing else needs to change.
