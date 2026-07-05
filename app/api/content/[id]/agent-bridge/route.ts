/**
 * Atrium agent bridge endpoint (#1051)
 *
 * POST /api/content/[id]/agent-bridge — lets an agent push markdown into the live
 * collaborative document, attributed to the agent (purple rail). This is the
 * rebuilt equivalent of Proof's bridge: the `X-Agent-Id` header maps to the agent
 * label stamped on the rail, and the edit diffs into the same Y.Doc connected
 * editors hold.
 *
 * Safety (spec §28.3): the agent's markdown is screened by Bedrock Guardrails
 * (blocked content is rejected, never persisted) and scanned for PII (logged as
 * telemetry — document content is NOT tokenized, since a published document must
 * keep its real text) BEFORE it touches the document. The screening core lives
 * in `lib/content/agent-screening.ts` (shared with `contentService.create` /
 * `versionService.snapshot`); this route only maps its verdict to HTTP.
 *
 * Auth (Phase 1): a logged-in human with edit rights on the object operates the
 * agent; the session is the authorization conduit and the X-Agent-Id is the
 * attribution. (Autonomous-agent auth via API keys is a later phase.)
 */

import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserRequester } from "@/actions/db/atrium/requester";
import { contentService } from "@/lib/content/content-service";
import { visibilityService } from "@/lib/content/visibility-service";
import { canEdit } from "@/lib/content/helpers";
import { screenAgentContent } from "@/lib/content/agent-screening";
import { executeQuery } from "@/lib/db/drizzle-client";
import { agentIdentities } from "@/lib/db/schema";
import { applyAgentEdit, type AgentEditMode } from "@/lib/content/collab/apply-agent-edit";

/** UUID v4-ish shape — the form `agent_identities.id` takes (defaultRandom()). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per-document in-process async serialization lock (keyed on objectId).
 *
 * In "append" mode the screen→apply sequence reads the current doc state and
 * then writes new content. If two concurrent agent-bridge requests target the
 * SAME document, each could independently pass Bedrock Guardrails screening and
 * then both apply in overlapping CRDT transactions — a TOCTOU race that lets
 * combined content bypass the guardrail that reviewed each piece in isolation.
 *
 * This map chains each incoming request for a given objectId behind the
 * previous request's completion (a promise chain / async mutex). Only one
 * screen→apply sequence per document runs at a time within this ECS task.
 *
 * SCOPE: in-process only. Multiple ECS tasks do NOT share this lock; two tasks
 * handling concurrent requests for the same document can still race. Cross-task
 * serialization (e.g. a DynamoDB or Redis distributed lock) is a documented
 * Phase 2 concern and is NOT added here to avoid the operational complexity of
 * a Redis dependency (local dev has no Redis; it is optional).
 */
const _docLocks = new Map<string, Promise<void>>();

/**
 * Acquire the per-document lock, run `fn`, then release. Cleans up the map
 * entry when this call is the last in the chain so the map stays bounded.
 */
async function withDocumentLock<T>(objectId: string, fn: () => Promise<T>): Promise<T> {
  const prior = _docLocks.get(objectId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => { release = res; });
  // Capture the chained promise in ONE variable: `prior.then(...)` returns a NEW
  // promise each call, so we must store the SAME reference we later identity-check
  // against — comparing two separate `.then()` results would never match, leaking
  // the map entry forever (unbounded growth for documents that stop receiving writes).
  const chained = prior.then(() => next);
  _docLocks.set(objectId, chained);
  try {
    await prior;
    return await fn();
  } finally {
    release();
    // Clean up only if our chained promise is still the current tail. A later
    // request for the same objectId would have replaced it (and chained behind
    // `next`), in which case we must NOT delete — that request owns the entry.
    if (_docLocks.get(objectId) === chained) {
      _docLocks.delete(objectId);
    }
  }
}


/**
 * Validate the attribution agent id. The `X-Agent-Id` header is stamped onto the
 * CRDT nodes the edit produces, so anything that trusts that mark (audit trail, UI
 * attribution, export) trusts this value.
 *
 * - A UUID-shaped id is treated as a claim of a registered `agent_identities` row:
 *   it MUST exist and be active, else we reject (403). This prevents spoofing
 *   `X-Agent-Id: <real-bot-uuid>`.
 * - A non-UUID free-form label (e.g. a registered agent's `name` like
 *   "ship-reporter", or an ad-hoc "drafting-agent") is accepted as-is.
 *
 * KNOWN LIMITATION (Phase 1, documented per PR #1062 review): the free-form-label
 * branch performs NO identity verification. Because `agent_identities.id` is a
 * `defaultRandom()` UUID not knowable at call sites, the legitimate way to attribute
 * an edit to a registered agent in Phase 1 IS its name — so any logged-in human with
 * edit rights can stamp `ai:<any-label>`, including the NAME of a registered agent.
 * This is acceptable for Phase 1 because the route's authorization model is "a
 * logged-in human with edit rights operates the agent; the session is the
 * authorization conduit and X-Agent-Id is attribution" (see route header) — it is
 * cosmetic, session-gated attribution, NOT authenticated agent identity. Autonomous
 * agents authenticating as themselves (binding a verified identity to the label via
 * API keys, which would let us reject by-name impersonation) arrive in a later phase.
 *
 * Returns true when the id may be used for attribution, false when it must be rejected.
 */
async function isAttributableAgentId(agentId: string): Promise<boolean> {
  if (!UUID_RE.test(agentId)) return true;
  const rows = await executeQuery(
    (db) =>
      db
        .select({ id: agentIdentities.id })
        .from(agentIdentities)
        .where(and(eq(agentIdentities.id, agentId), eq(agentIdentities.isActive, true)))
        .limit(1),
    "atrium.agentBridge.validateAgentId"
  );
  return rows.length > 0 && rows[0] != null;
}

interface BridgeBody {
  markdown?: unknown;
  mode?: unknown;
}

function parseMode(mode: unknown): AgentEditMode {
  return mode === "append" ? "append" : "replace";
}

/** Resolve the object and confirm the caller may edit it. Returns the object, or
 * a NextResponse to return on any failure (existence-masking 404 / 403). */
async function loadEditableObject(
  id: string,
  req: Awaited<ReturnType<typeof getUserRequester>>
): Promise<{ obj: { id: string; ownerUserId: number } } | { error: NextResponse }> {
  const obj = await contentService.loadByIdOrSlug(id);
  if (!obj) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  const viewable = await visibilityService.canView(req, {
    id: obj.id,
    ownerUserId: obj.ownerUserId,
    visibilityLevel: obj.visibilityLevel,
  });
  if (!viewable) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  if (!canEdit(req, obj.ownerUserId)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { obj: { id: obj.id, ownerUserId: obj.ownerUserId } };
}

/** Screen agent markdown via the shared §28.3 core (`lib/content/agent-screening`
 * — guardrails fail-closed + PII telemetry, logging included). `requestId` threads
 * this request's correlation onto the core's blocked/degraded log lines. This
 * wrapper only maps the verdict to HTTP: 422 for blocked content, 503 for a
 * degraded (unavailable) screening evaluation. Returns null to proceed. */
async function screenAgentMarkdown(
  markdown: string,
  objectId: string,
  requestId: string
): Promise<NextResponse | null> {
  const verdict = await screenAgentContent(markdown, objectId, requestId);
  if (verdict.allowed) return null;
  if (verdict.reason === "blocked") {
    return NextResponse.json(
      { error: "Content blocked by safety policy", message: verdict.message },
      { status: 422 }
    );
  }
  return NextResponse.json(
    { error: "Safety screening unavailable", message: verdict.message },
    { status: 503 }
  );
}

async function postHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("POST /api/content/[id]/agent-bridge");
  const log = createLogger({ requestId, endpoint: "POST /api/content/[id]/agent-bridge" });

  try {
    const { id } = await params;

    const session = await getServerSession();
    if (!session?.sub) {
      timer({ status: "error" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // `request.json()` can resolve to `null` (valid JSON) — coerce to {} so
    // the BridgeBody destructure doesn't throw a TypeError on `null.markdown`.
    const body = ((await request.json().catch(() => ({}))) ?? {}) as BridgeBody;
    const markdown = typeof body.markdown === "string" ? body.markdown : "";
    if (!markdown.trim()) {
      timer({ status: "error" });
      return NextResponse.json({ error: "markdown is required" }, { status: 400 });
    }
    // Guard before Bedrock Guardrails: its internal limit is ~64 KB; oversized
    // payloads degrade silently to "allowed" and would broadcast a huge Yjs update.
    if (Buffer.byteLength(markdown, "utf8") > 512 * 1024) {
      timer({ status: "error" });
      return NextResponse.json({ error: "markdown too large (max 512 KB)" }, { status: 413 });
    }
    const mode = parseMode(body.mode);
    // Validate X-Agent-Id: it's stamped into every CRDT node and JWT sub.
    // An unbounded value would bloat the Y.Doc and could overflow JWT headers.
    const rawAgentId = (request.headers.get("x-agent-id") || "agent").trim();
    const agentId = /^[\w-]{1,128}$/.test(rawAgentId) ? rawAgentId : "agent";

    // Thread the already-resolved session so getUserRequester reuses it instead of
    // calling getServerSession() a second time (double JWT-verify per request).
    const req = await getUserRequester(requestId, session);
    const loaded = await loadEditableObject(id, req);
    if ("error" in loaded) {
      timer({ status: "error" });
      return loaded.error;
    }

    // Validate attribution AFTER the edit-rights gate so a caller without edit
    // rights can't probe which agent_identities ids exist. A UUID-shaped id must
    // map to an active registered identity; spoofing a real bot's uuid is rejected.
    if (!(await isAttributableAgentId(agentId))) {
      log.warn("Agent write rejected: unknown/inactive agent identity", { objectId: loaded.obj.id });
      timer({ status: "error" });
      return NextResponse.json({ error: "Unknown agent identity" }, { status: 403 });
    }

    // Serialize screen→apply for this document to prevent a TOCTOU race:
    // two concurrent append-mode requests could each pass Bedrock Guardrails
    // independently and then both apply in overlapping CRDT transactions, letting
    // their combined content bypass the guardrail that reviewed each in isolation.
    // withDocumentLock ensures only one screen→apply sequence runs per objectId at
    // a time within this ECS task. See the _docLocks comment for cross-task scope.
    const lockResult = await withDocumentLock(loaded.obj.id, async () => {
      const blocked = await screenAgentMarkdown(markdown, loaded.obj.id, requestId);
      if (blocked) return blocked;
      await applyAgentEdit({ objectId: loaded.obj.id, markdown, agentId, mode });
      return null;
    });
    if (lockResult !== null) {
      // screenAgentMarkdown returned a blocked response inside the lock.
      timer({ status: "error" });
      return lockResult;
    }

    timer({ status: "success" });
    log.info("Applied agent edit", { objectId: loaded.obj.id, agentId, mode });
    return NextResponse.json({ applied: true, mode });
  } catch (error) {
    timer({ status: "error" });
    log.error("Agent bridge failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export { postHandler as POST };
