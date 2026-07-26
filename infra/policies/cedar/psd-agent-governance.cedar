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

// Google Workspace and schedule operations cross signed web brokers. The
// model runtime receives no direct Google or DynamoDB action.

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

// PSD Agent Gateway — psd-classified-evaluation skill (#1230). The n8n MCP
// Server Trigger that runs the classified-evaluation pipeline server-side. Only
// the hostname + generic /mcp prefix are named here; the full gateway path lives
// solely in the psd-agent/{env}/agent-gateway secret (this is a public repo).
permit(
  principal,
  action == Action::"http.request",
  resource
)
when { resource.url like "https://n8n.psd401.net/mcp/*" };

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

// =========================================================================
// SKILLS PLATFORM — scope-based execution policies (#910)
// =========================================================================

// Allow execution of core image skills (baked into container)
permit(
  principal,
  action == Action::"skill.execute",
  resource
)
when { resource.path like "/home/node/.openclaw/skills/*" };

// Allow execution of shared skills (district-wide, admin-reviewed)
permit(
  principal,
  action == Action::"skill.execute",
  resource
)
when { resource.path like "/home/node/.openclaw/skills-shared/*" };

// Allow execution of user's own approved skills
permit(
  principal,
  action == Action::"skill.execute",
  resource
)
when { resource.path like "/home/node/.openclaw/skills-user/*" };

// Block execution of draft skills unless explicitly permitted
forbid(
  principal,
  action == Action::"skill.execute",
  resource
)
when { resource.path like "/home/node/.openclaw/skills-drafts/*" };

// =========================================================================
// CREDENTIALS — scope-based access policies (#910)
// =========================================================================

// All model-runtime secret access is blocked. Credential operations cross the
// signed web broker, which binds the owner at the final data boundary.
forbid(
  principal,
  action == Action::"secret.read",
  resource
);

forbid(
  principal,
  action == Action::"secret.write",
  resource
);

// =========================================================================
// GOOGLE WORKSPACE — psd-workspace skill (#912)
// =========================================================================

// Allow the consent-link endpoint on the Next.js app. It verifies the signed
// invocation context before minting a one-time owner-bound URL.
permit(
  principal,
  action == Action::"http.request",
  resource
)
when {
  resource.url like "https://*.psd401.ai/api/agent/consent-link" ||
  resource.url like "https://psd401.ai/api/agent/consent-link"
};

// Allow only the agnt_ account-request provisioning endpoint (#1233).
// Raw Workspace-token delivery to the model was retired; Workspace operations
// use the signed, allowlisted operation broker.
permit(
  principal,
  action == Action::"http.request",
  resource
)
when {
  resource.url like "https://*.psd401.ai/api/agent/account-request" ||
  resource.url like "https://psd401.ai/api/agent/account-request"
};

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
  // psd-workspace skill (#912): consent-link endpoint on the Next.js app
  resource.url like "https://*.psd401.ai/api/agent/consent-link" ||
  resource.url like "https://psd401.ai/api/agent/consent-link" ||
  // agnt_ account-request (#1233); raw token delivery is intentionally absent
  resource.url like "https://*.psd401.ai/api/agent/account-request" ||
  resource.url like "https://psd401.ai/api/agent/account-request" ||
  // Fixed signed brokers. No wildcard below /api/agent/ is intentional.
  resource.url like "https://*.psd401.ai/api/agent/aistudio" ||
  resource.url like "https://psd401.ai/api/agent/aistudio" ||
  resource.url like "https://*.psd401.ai/api/agent/atrium" ||
  resource.url like "https://psd401.ai/api/agent/atrium" ||
  resource.url like "https://*.psd401.ai/api/agent/canva" ||
  resource.url like "https://psd401.ai/api/agent/canva" ||
  resource.url like "https://*.psd401.ai/api/agent/classified-evaluation" ||
  resource.url like "https://psd401.ai/api/agent/classified-evaluation" ||
  resource.url like "https://*.psd401.ai/api/agent/credentials" ||
  resource.url like "https://psd401.ai/api/agent/credentials" ||
  resource.url like "https://*.psd401.ai/api/agent/email-triage" ||
  resource.url like "https://psd401.ai/api/agent/email-triage" ||
  resource.url like "https://*.psd401.ai/api/agent/failures" ||
  resource.url like "https://psd401.ai/api/agent/failures" ||
  resource.url like "https://*.psd401.ai/api/agent/github-execute" ||
  resource.url like "https://psd401.ai/api/agent/github-execute" ||
  resource.url like "https://*.psd401.ai/api/agent/schedules" ||
  resource.url like "https://psd401.ai/api/agent/schedules" ||
  resource.url like "https://*.psd401.ai/api/agent/skills" ||
  resource.url like "https://psd401.ai/api/agent/skills" ||
  resource.url like "https://*.psd401.ai/api/agent/workspace-execute" ||
  resource.url like "https://psd401.ai/api/agent/workspace-execute" ||
  resource.url like "https://*.psd401.ai/api/agent/workspace-storage" ||
  resource.url like "https://psd401.ai/api/agent/workspace-storage" ||
  // PSD Agent Gateway (#1230): n8n MCP Server Trigger for psd-classified-evaluation.
  // Hostname + generic /mcp prefix only — the full gateway path stays out of this
  // public repo and lives only in the psd-agent/{env}/agent-gateway secret.
  resource.url like "https://n8n.psd401.net/mcp/*"
};
