/**
 * Agent-bridge publish/unpublish error → HTTP response mapping (Epic #1059).
 *
 * Extracted from the agent-bridge route so the mapping is unit-testable under
 * jest: the route module itself pulls the collab/TipTap ESM chain (not
 * jest-loadable — bridge coverage otherwise lives in Bun smokes and the
 * PLAYWRIGHT_AUTH_ENABLED-gated E2E), while this module depends only on the
 * lean `errors.ts`.
 *
 * Semantics (must stay in lockstep with `publishService`):
 * - `ApprovalRequiredError` → 202: a public destination the acting operator may
 *   not publish/unpublish directly is a pending-approval OUTCOME (§26.4 — the
 *   approval-queue event was already emitted inside the service), not a
 *   failure. The agent must report "queued for review", never claim success
 *   and never bypass the gate.
 * - `NotFoundError` → 404 / `ForbiddenError` → 403: defensive re-mapping; the
 *   route's `loadEditableObject` already 404-masks/403s before the service
 *   runs, so these are rare double-checks, with the same masked bodies.
 * - `ValidationError` → 400 with the validator's message (also used for the
 *   `assertEditorDestination` pre-check, which rejects `okf` and unknown
 *   destinations on the editor/agent surfaces).
 * - Anything else → `null`: the caller must rethrow so unexpected failures
 *   surface as 500s instead of being silently swallowed into a mapped status.
 */

import {
  ApprovalRequiredError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "./errors";

export interface AgentPublishErrorResponse {
  status: 202 | 400 | 403 | 404;
  body: Record<string, unknown>;
}

export const AGENT_PUBLISH_APPROVAL_MESSAGE =
  "This destination requires administrator approval — the request has been submitted for review.";

export function mapAgentPublishError(
  error: unknown,
  op: "publish" | "unpublish",
  destination: string
): AgentPublishErrorResponse | null {
  if (error instanceof ApprovalRequiredError) {
    return {
      status: 202,
      body: {
        applied: false,
        op,
        destination,
        approvalRequired: true,
        message: AGENT_PUBLISH_APPROVAL_MESSAGE,
      },
    };
  }
  if (error instanceof NotFoundError) {
    return { status: 404, body: { error: "Not found" } };
  }
  if (error instanceof ForbiddenError) {
    return { status: 403, body: { error: "Forbidden" } };
  }
  if (error instanceof ValidationError) {
    return { status: 400, body: { error: error.message } };
  }
  return null;
}
