# PSD AI Agent Platform — Rate Limiting Design

> **DOCUMENTATION ONLY** — No Cedar policy rules in this file.  
> Rate limits are enforced by application code (Router Lambda, AgentCore env vars).  
> This file documents the design contract for operational limits.

Limits are intentionally conservative for Phase 1 (6 users).
Increase as trust and monitoring mature.

## Tool Invocation Limits

- **Max 10 tool invocations per minute per agent**
- Prevents runaway tool-call loops (e.g., recursive file operations)
- Per-session limit — multiple messages share the same session counter
- **Enforced by:** AgentCore runtime configuration (`rateLimit` environment variable)

## Inter-Agent Communication Limits

- **Max 5 inter-agent messages per agent per hour**
- Prevents ant-death-spiral loops between agents
- **Enforced by:** Router Lambda via DynamoDB counters (`isInterAgentRateLimited`)
- **Anti-loop protection:** 3rd+ message from the same bot in the same thread
  within an hour is blocked (2 exchanges allowed before the 3rd is suppressed).
  Unthreaded messages in the same space share a space-stable thread key so
  top-level bot chatter also trips the limit.

### Threat model — why two different limits?

| Limit | Guards against |
|---|---|
| 5 msg/agent/hour rate limit | Spam (one bot hammering many threads/rooms) |
| 3rd-message-per-(sender, thread) anti-loop | Tight feedback loops (two bots ping-ponging in one thread) |

A pair of bots could theoretically stay under the anti-loop threshold by
spreading messages across threads, but the hourly rate limit would still
catch sustained cross-thread spam. Conversely, a single bot ping-ponging in
one thread would trip anti-loop long before hitting the hourly rate cap.

### Operational note: blocked messages still count

`recordInterAgentMessage` writes the DynamoDB record **before**
`isInterAgentRateLimited` checks the count (write-before-read prevents a race
where two concurrent writers both pass a stale check). As a side effect, a
bot that retries after hitting the limit keeps adding records and extending
its cool-down window. This is intentional — aggressive retry = aggressive
rate limit — but surface the behavior during incident response so operators
don't think a legitimate bot is permanently locked out.

## Token Limits

- **Max 100K tokens per interaction** (alerting threshold at Router Lambda)
- **Enforced by:** Router Lambda `TOKEN_LIMIT_PER_INTERACTION` environment variable
- Responses are still delivered but logged as warnings
- Hard enforcement planned for Phase 2 via pre-invocation token estimation
