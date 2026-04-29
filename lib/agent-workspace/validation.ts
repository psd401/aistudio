/**
 * Shared validation utilities for the agent workspace integration.
 *
 * Centralizes email validation so the consent-link route and secrets-manager
 * module stay in sync. The regex prevents path traversal when email is
 * interpolated into Secrets Manager paths (e.g. psd-agent-creds/{env}/user/{email}/...).
 *
 * Part of Epic #912 — Agent-Owned Google Workspace Integration
 */

/**
 * Strict email regex — alphanumeric + common email chars only.
 * Rejects `/`, `..`, and other characters that could be used for
 * Secrets Manager path traversal.
 */
export const SAFE_EMAIL_RE = /^[\w%+.-]+@[\d.A-Za-z-]+\.[A-Za-z]{2,}$/
