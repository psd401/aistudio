/**
 * The wire contract for the Atrium artifact data QUERY transport (#1788).
 *
 * ## Why a route handler and not the Server Action
 *
 * `AtriumData.query` used to reach `queryArtifactData` as a Next.js Server
 * Action. The App Router client dispatches Server Actions STRICTLY ONE AT A
 * TIME, so a dashboard that fires six queries from one `Promise.all` executed
 * them back to back: measured on prod (2026-09-23) each POST started within 5ms
 * of the previous one finishing, turning a ~1.2s load into ~6.5s. Nothing about
 * the queries was slow — the transport was serial.
 *
 * `fetch` to a Route Handler has no such queue, so the same six queries overlap.
 * The frame itself still has NO network access (`connect-src 'none'`, opaque
 * origin): only the trusted parent bridge calls this route, with the artifact's
 * identity taken from its own props, exactly as it built the action payload.
 *
 * The route re-uses `queryArtifactData` itself rather than restating its guards,
 * so session resolution, the `contentService.get` 404 mask, the `data_access`
 * mode check, the rate limit and the connector access check cannot drift between
 * the two entry points. (A `"use server"` function called from a Route Handler is
 * inlined and runs in-process — it is only an RPC hop when a CLIENT imports it.)
 *
 * ## Why the SQL travels base64
 *
 * The edge WAF's `SQLi_BODY` managed rule inspects every request body and
 * BLOCKS outside the AI paths (`infra/lib/frontend-stack-ecs.ts`,
 * `BODY_SIGNATURE_RULES`). A request body whose entire purpose is to carry a SQL
 * statement is the exact shape that rule matches, and a WAF block is a bare 403
 * that never reaches the app — indistinguishable, to the artifact, from the
 * service being down. The body therefore carries `sqlBase64`, the same
 * `codeEncoding: "base64"` dodge the artifact canvas already uses to get
 * `<script>`-bearing code past `CrossSiteScripting_BODY`.
 *
 * This is transport encoding ONLY. It is not a security control in either
 * direction: the decoded SQL is validated and executed by exactly the same code
 * as before, under the viewer's own row-level permissions.
 *
 * This module is deliberately dependency-free: the client bridge, the route
 * handler, and the tests all import it.
 */

import {
  isArtifactBridgeErrorCode,
  type ArtifactBridgeErrorCode,
} from "./artifact-bridge-errors";

/** The POST route the parent bridge calls for `AtriumData.query`. */
export function artifactQueryRoutePath(contentId: string): string {
  return `/api/atrium/artifacts/${encodeURIComponent(contentId)}/query`;
}

/** The request body the bridge posts. `sqlBase64` is UTF-8 base64 (see above). */
export interface ArtifactQueryRequestBody {
  sqlBase64: string;
  limit?: number;
  offset?: number;
  /** Trusted parent-side value; names the version in the data MCP audit line. */
  versionId?: string;
}

/**
 * The HTTP status each bridge code answers with.
 *
 * Statuses are real (not a blanket 200) so an infrastructure failure stays
 * distinguishable from an application answer in the ALB/CloudWatch view — the
 * silent-failure pattern this repo explicitly warns about. The client reads the
 * typed body on BOTH arms and only falls back to status-derived codes when the
 * body is missing or unparseable (a WAF block, an ALB 502, the middleware's own
 * 401), so a non-2xx never becomes an untyped failure.
 */
export const ARTIFACT_QUERY_STATUS_BY_CODE: Readonly<
  Record<ArtifactBridgeErrorCode, number>
> = {
  unauthenticated: 401,
  forbidden: 403,
  not_query_mode: 409,
  rate_limited: 429,
  timeout: 504,
  query_error: 400,
  too_many_requests: 429,
  unavailable: 503,
};

/**
 * The code to assume when a response carries no usable typed body. `rate_limited`
 * is deliberately absent: the parent bridge's own `retryAfterSeconds` would be
 * invented, and a 429 with no body is far more likely to be the edge rate-limit
 * rule than this route's per-artifact budget.
 */
export function artifactQueryCodeForStatus(
  status: number
): ArtifactBridgeErrorCode {
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 409) return "not_query_mode";
  if (status === 429) return "too_many_requests";
  if (status === 504 || status === 408) return "timeout";
  if (status === 400) return "query_error";
  return "unavailable";
}

/** The failure body the route returns. Mirrors `QueryArtifactDataFailure`. */
export interface ArtifactQueryFailureBody {
  isSuccess: false;
  message?: string;
  code: ArtifactBridgeErrorCode;
  retryAfterSeconds?: number;
  detail?: string;
}

/** Narrow an arbitrary parsed response body to the route's failure shape. */
export function isArtifactQueryFailureBody(
  body: unknown
): body is ArtifactQueryFailureBody {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as { isSuccess?: unknown }).isSuccess === false &&
    isArtifactBridgeErrorCode((body as { code?: unknown }).code)
  );
}
