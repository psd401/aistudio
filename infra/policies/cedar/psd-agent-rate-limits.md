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
- Anti-loop protection: 2+ messages from same bot in same thread triggers block

## Token Limits

- **Max 100K tokens per interaction** (alerting threshold at Router Lambda)
- **Enforced by:** Router Lambda `TOKEN_LIMIT_PER_INTERACTION` environment variable
- Responses are still delivered but logged as warnings
- Hard enforcement planned for Phase 2 via pre-invocation token estimation
