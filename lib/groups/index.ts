/**
 * Google Directory group-sync service module (Epic #1202, Phase 0 / #1203).
 *
 * App-side surface for the group-sync feature:
 *   - normalize / selection: pure email + rule resolution (shared with the Lambda)
 *   - settings: database-first group-sync configuration
 *   - queries: read + selection-rule CRUD backing /admin/groups
 *   - trigger: manual "Sync now" (async invoke of the hourly sync Lambda)
 *
 * The membership WRITE path (Google fetch + transitive flatten + full-replace
 * reconciliation with last-known-good fail-safety) lives in the isolated sync
 * Lambda at infra/lambdas/group-sync — it cannot import this module.
 */

export * from "./normalize";
export * from "./selection";
export * from "./settings";
export * from "./queries";
export * from "./trigger";
