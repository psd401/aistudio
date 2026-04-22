// PSD AI Agent Platform — Cedar Governance Policies
//
// These policies are enforced by AgentCore Policy at the tool-call boundary,
// outside the agent's code. They cannot be prompt-injected around.
//
// Storage: S3 bucket psd-agents-{env}-{account}/policies/
// Update: Change this file and re-upload to S3 — AgentCore picks up on next session.
// No stack redeployment required.
//
// Action Authorization Tiers:
//   Auto    — permitted without human confirmation
//   Blocked (Confirm at App Layer) — Cedar blocks; app code must implement
//            approval flow (agent presents draft in Chat, human approves)
//   Blocked — permanently forbidden
//
// Reference: https://www.cedarpolicy.com/

// =========================================================================
// AUTO-PERMITTED ACTIONS (read-only operations, safe by default)
// =========================================================================

// Allow reading calendar and email (non-destructive)
permit(
  principal,
  action == Action::"google.calendar.read",
  resource
);

permit(
  principal,
  action == Action::"google.gmail.read",
  resource
);

// Allow reading Google Drive files
permit(
  principal,
  action == Action::"google.drive.read",
  resource
);

// Allow per-user schedule management via DynamoDB on the schedules table only.
// The agent can only act on schedule rows keyed to the authenticated caller's
// email (enforced in application logic — DynamoDB does not natively scope by
// item attribute). The ${env} placeholder is rendered server-side when
// AgentCore loads the policy bundle from S3.
permit(
  principal,
  action in [
    Action::"dynamodb.PutItem",
    Action::"dynamodb.UpdateItem",
    Action::"dynamodb.DeleteItem",
    Action::"dynamodb.GetItem",
    Action::"dynamodb.Query"
  ],
  resource
)
when {
  principal.type == "AgentCore::Runtime" &&
  resource.table like "psd-agent-schedules-*"
};

// Allow file writes within the agent's own workspace (sandboxed per-user in S3)
permit(
  principal,
  action == Action::"file.write",
  resource
)
when { resource.path like "/workspace/*" };

// Allow shell execution within AgentCore microVM sandbox.
// Each agent session runs in an ephemeral VM that is destroyed after
// the session ends. No persistent filesystem access, no network access to
// internal resources (controlled by Cedar http.request rules above/below).
// Scoped to AgentCore::Runtime principals to prevent future multi-tenant
// agent types from inheriting unrestricted shell access.
permit(
  principal,
  action == Action::"shell.execute",
  resource
)
when { principal.type == "AgentCore::Runtime" };

// HTTP request permits — these express intent but are NOT what allows the URLs.
// In Cedar, the catch-all `forbid(... http.request ...)` at the bottom of this
// file overrides all permits. The actual allowlist lives in that forbid's
// `unless` clause. These permits are kept for documentation and in case the
// catch-all forbid is removed in the future.
permit(
  principal,
  action == Action::"http.request",
  resource
)
when { resource.url like "https://api.psd401.net/*" };

permit(
  principal,
  action == Action::"http.request",
  resource
)
when { resource.url like "https://*.googleapis.com/*" };

permit(
  principal,
  action == Action::"http.request",
  resource
)
when { resource.url like "https://*.google.com/*" };

// =========================================================================
// BLOCKED — REQUIRE CONFIRMATION FLOW AT APP LAYER
// Cedar only has permit/forbid — there is no native "confirm" tier.
// These actions are BLOCKED by Cedar. The confirmation UX (agent presents
// a draft in Chat, human approves, then the app layer calls the action
// without going through Cedar) must be implemented in application code.
//
// Until the confirmation UX is built, AgentCore returns a Cedar policy
// denial to the agent, which surfaces as a tool-call failure. The agent
// will explain that it cannot perform the action due to governance policy.
// Tracked: confirmation UX is part of the Phase 2 agent platform roadmap.
// =========================================================================

// Block sending email — agent must present draft in Chat for approval
forbid(
  principal,
  action == Action::"google.gmail.send",
  resource
);

// Block creating calendar events — agent must present details for approval
forbid(
  principal,
  action == Action::"google.calendar.create",
  resource
);

// Block modifying calendar events — agent must confirm changes
forbid(
  principal,
  action == Action::"google.calendar.update",
  resource
);

// Block deleting calendar events
forbid(
  principal,
  action == Action::"google.calendar.delete",
  resource
);

// Block creating/modifying Google Drive files outside workspace
forbid(
  principal,
  action == Action::"google.drive.write",
  resource
);

// =========================================================================
// BLOCKED ACTIONS (permanently forbidden — K-12 safety)
// =========================================================================

// Block access to student data systems (PowerSchool, SIS)
forbid(
  principal,
  action == Action::"http.request",
  resource
)
when { resource.url like "*powerschool*" };

forbid(
  principal,
  action == Action::"http.request",
  resource
)
when { resource.url like "*studentvue*" };

forbid(
  principal,
  action == Action::"http.request",
  resource
)
when { resource.url like "*synergy*" };

// Block installing external skills from non-approved sources.
// The bucket naming convention is psd-agents-{env}-{accountId}.
// Restrict to that pattern — a bare "psd-agents-*" would match attacker-created
// buckets like "psd-agents-pwned". The "*-*" suffix requires at least two
// segments (env + account).
forbid(
  principal,
  action == Action::"skill.install",
  resource
)
unless { resource.source like "s3://psd-agents-*-*/*" };

// Block all external HTTP requests unless explicitly allowlisted below.
// This is the default-deny catch-all for network access.
// To allow new endpoints, add them to the `unless` clause below.
// NOTE: In Cedar, forbid always overrides permit — adding a permit()
// for http.request would NOT bypass this rule.
forbid(
  principal,
  action == Action::"http.request",
  resource
)
unless {
  resource.url like "https://api.psd401.net/*" ||
  resource.url like "https://*.googleapis.com/*" ||
  resource.url like "https://*.google.com/*"
};
