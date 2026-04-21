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
//   Confirm — requires human approval (agent presents draft in Chat)
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

// Allow file writes within the agent's own workspace (sandboxed per-user in S3)
permit(
  principal,
  action == Action::"file.write",
  resource
)
when { resource.path like "/workspace/*" };

// Allow shell execution — unrestricted because the AgentCore microVM IS the
// sandbox. Each agent session runs in an ephemeral VM that is destroyed after
// the session ends. No persistent filesystem access, no network access to
// internal resources (controlled by Cedar http.request rules above/below).
// This is intentionally broad for Phase 1 — scope to specific principals if
// multi-tenant agent types are introduced.
permit(
  principal,
  action == Action::"shell.execute",
  resource
);

// Allow reading district data from approved internal systems
permit(
  principal,
  action == Action::"http.request",
  resource
)
when { resource.url like "https://api.psd401.net/*" };

// Allow Google API access (required for Calendar, Gmail, Drive operations)
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
// CONFIRM-REQUIRED ACTIONS (agent must present draft for human approval)
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
when { resource.url like "*synergysis*" };

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
