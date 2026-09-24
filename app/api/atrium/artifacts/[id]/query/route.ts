/**
 * `POST /api/atrium/artifacts/{id}/query` — the viewer-scoped PSD data read
 * behind `AtriumData.query` (#1705), moved off Next.js Server Actions (#1788).
 *
 * See `lib/content/artifact-query-transport.ts` for WHY this route exists (the
 * App Router dispatches Server Actions one at a time, which serialized every
 * dashboard's queries) and why the SQL arrives base64-encoded (the edge WAF's
 * `SQLi_BODY` rule blocks bodies that look like SQL, with a bare 403 the app
 * never sees).
 *
 * ## Guards
 *
 * Every guard the Server Action applies still applies, because this route CALLS
 * that action rather than restating it: session + ID token, the per-viewer /
 * per-artifact rate limit, the `contentService.get` 404 mask, the `data_access`
 * mode check, the version-ownership check for the audit line, and the connector
 * access check inside `getConnectorTools`. A `"use server"` function invoked
 * from a Route Handler is inlined and runs in this process — the `"use server"`
 * marker only means "callable by a client", never "this is a network boundary".
 *
 * Unauthenticated callers do not reach the handler at all: `middleware.ts`
 * answers `/api/*` with a 401 for a signed-out request, and the action itself
 * fails closed a second time.
 *
 * The artifact id comes from the URL, and the parent bridge fills it from its
 * OWN trusted props — never from the frame's message — exactly as it filled the
 * action payload.
 */

import { NextRequest, NextResponse } from "next/server";
import { queryArtifactData } from "@/actions/db/atrium/artifact-query";
import {
  BoundedJsonRequestError,
  parseBoundedJsonRequest,
} from "@/lib/api/bounded-json-request";
import { decodeContentBody } from "@/lib/content/code-encoding";
import {
  artifactBridgeErrorMessage,
  type ArtifactBridgeErrorCode,
} from "@/lib/content/artifact-bridge-errors";
import {
  ARTIFACT_QUERY_STATUS_BY_CODE,
  type ArtifactQueryRequestBody,
} from "@/lib/content/artifact-query-transport";
import { createLogger, generateRequestId } from "@/lib/logger";

/** The action reaches Postgres and an MCP client: Node runtime, never Edge. */
export const runtime = "nodejs";

/**
 * The most this route will read off the wire before refusing (#1788).
 *
 * The action caps the DECODED SQL at 8,000 characters, and the shared decoder's
 * own ceiling is 5 MB — three orders of magnitude of slack that nothing else
 * closes: the edge WAF deliberately excludes `SizeRestrictions_BODY` (see
 * `lib/content/code-encoding.ts`), so without this the SSR task would buffer and
 * parse a multi-megabyte body before rejecting it, and reject it HERE — before
 * `queryArtifactData` consumes a rate-limit slot, so the 60/min budget would not
 * throttle the loop at all.
 *
 * 64 KiB clears the legitimate worst case comfortably: 8,000 characters of
 * 3-byte UTF-8 is 24,000 bytes, ~32,000 base64 characters, plus a little JSON.
 */
const MAX_QUERY_REQUEST_BYTES = 64 * 1024;

/**
 * A body this route refused before the action ran — unparseable JSON, a
 * `sqlBase64` that is not base64. `query_error` because it describes the
 * REQUEST, and its message is this server's own text about the caller's own
 * request, so it is safe for any viewer (the same rule `artifact-query.ts`
 * applies to its validation failures).
 */
function badRequest(
  message: string,
  status: number = ARTIFACT_QUERY_STATUS_BY_CODE.query_error
): NextResponse {
  return NextResponse.json(
    { isSuccess: false, code: "query_error" satisfies ArtifactBridgeErrorCode, message },
    { status }
  );
}

/** An optional numeric field, passed through for the action to bound/clamp. */
function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId();
  const log = createLogger({ requestId, route: "api.atrium.artifactQuery" });
  const { id } = await params;

  let body: Partial<ArtifactQueryRequestBody>;
  try {
    // Bounded rather than `req.json()`: the stream is counted as it arrives, so
    // an understated Content-Length cannot get a large body buffered anyway.
    body = (await parseBoundedJsonRequest(
      req,
      MAX_QUERY_REQUEST_BYTES
    )) as Partial<ArtifactQueryRequestBody>;
  } catch (error) {
    if (error instanceof BoundedJsonRequestError) {
      return badRequest(
        error.code === "PAYLOAD_TOO_LARGE"
          ? "Query request is too large"
          : "Request body is not valid JSON",
        error.status
      );
    }
    return badRequest("Request body is not valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return badRequest("Request body must be a JSON object");
  }
  if (typeof body.sqlBase64 !== "string") {
    return badRequest("sqlBase64 is required");
  }

  let sql: string;
  try {
    // Strict base64 validation lives in the shared decoder; a lenient decode
    // would turn a corrupted payload into garbled SQL the data MCP then
    // reports as a syntax error the author cannot explain.
    sql = decodeContentBody(body.sqlBase64, "base64") ?? "";
  } catch {
    return badRequest("sqlBase64 is not valid base64");
  }

  // The action owns every remaining decision, including its own validation of
  // `sql`, `limit` and `offset` and the full #1787 failure classification.
  const outcome = await queryArtifactData({
    contentId: id,
    sql,
    limit: optionalNumber(body.limit),
    offset: optionalNumber(body.offset),
    versionId: typeof body.versionId === "string" ? body.versionId : undefined,
  });

  if (outcome.isSuccess) {
    return NextResponse.json(outcome, { status: 200 });
  }

  // The action already logged the technical detail; this line only correlates
  // the HTTP answer with it.
  log.debug("Artifact data query refused", { contentId: id, code: outcome.code });
  return NextResponse.json(
    {
      ...outcome,
      message: outcome.message || artifactBridgeErrorMessage(outcome.code),
    },
    { status: ARTIFACT_QUERY_STATUS_BY_CODE[outcome.code] ?? 503 }
  );
}
