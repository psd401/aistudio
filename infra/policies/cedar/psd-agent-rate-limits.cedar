// PSD AI Agent Platform — Rate Limiting Policies
//
// These policies enforce operational limits on agent behavior.
// AgentCore Policy tracks call counts per session and enforces limits
// based on these policy declarations.
//
// Limits are intentionally conservative for Phase 1 (6 users).
// Increase as trust and monitoring mature.

// =========================================================================
// TOOL INVOCATION LIMITS
// =========================================================================

// Max 10 tool invocations per minute per agent
// Prevents runaway tool-call loops (e.g., recursive file operations).
// The limit is per-session — a user sending multiple messages in quick
// succession shares the same session limit.
//
// NOTE: AgentCore Policy enforces this via session-level counters.
// The Cedar policy below declares the intent; the AgentCore runtime
// configuration (rateLimit in environment variables) does the actual
// enforcement. This file documents the design contract.

// =========================================================================
// INTER-AGENT COMMUNICATION LIMITS
// =========================================================================

// Max 5 inter-agent messages per agent per hour
// Prevents ant-death-spiral loops between agents. Enforced by the
// Router Lambda (not Cedar) via DynamoDB counters. See Router Lambda
// inter-agent rate limiting code for implementation.

// =========================================================================
// TOKEN LIMITS
// =========================================================================

// Max 100K tokens per interaction (hard limit at Router Lambda)
// Enforced by the Router Lambda's TOKEN_LIMIT_PER_INTERACTION environment
// variable. This is an alerting threshold — responses are still delivered
// but logged as warnings. Hard enforcement is planned for Phase 2 via
// pre-invocation token estimation.
