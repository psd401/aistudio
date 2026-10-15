export const AISTUDIO_OPENCLAW_CLIENT_ID =
  "7e8646f4-4091-4a34-a6b9-0d3721e8a126"

export const AISTUDIO_OPENCLAW_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "platform:read",
  "repositories:list",
  "repositories:read",
  "repositories:search",
  "repositories:changes",
  // Issue #1907 — the agent could read repositories but never file anything into
  // one. These two must stay in step with the client's `allowed_scopes` column
  // (migration 189): the OIDC provider rejects an authorization request asking
  // for a scope the registered client does not allow.
  "repositories:write",
  "repositories:create",
] as const
