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
 * keep its real text) BEFORE it touches the document.
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
import { getContentSafetyService, getPIITokenizationService } from "@/lib/safety";
import { executeQuery } from "@/lib/db/drizzle-client";
import { agentIdentities } from "@/lib/db/schema";
import { applyAgentEdit, type AgentEditMode } from "@/lib/content/collab/apply-agent-edit";

/** UUID v4-ish shape — the form `agent_identities.id` takes (defaultRandom()). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validate the attribution agent id. The `X-Agent-Id` header is stamped onto the
 * CRDT nodes the edit produces, so anything that trusts that mark (audit trail, UI
 * attribution, export) trusts this value. A caller must not be able to attribute
 * their edit to a REGISTERED agent identity they do not control.
 *
 * - A UUID-shaped id is treated as a claim of a registered `agent_identities` row:
 *   it MUST exist and be active, else we reject (403). This prevents spoofing
 *   `X-Agent-Id: <real-bot-uuid>`.
 * - A non-UUID free-form label (Phase 1 cosmetic attribution, e.g. "drafting-agent")
 *   carries no registered identity to impersonate and is accepted as-is. Autonomous
 *   agents authenticating as themselves (and binding label→identity) arrive in a
 *   later phase per the route header.
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

type Logger = ReturnType<typeof createLogger>;

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

/** Screen agent markdown: block on guardrails, log PII (telemetry only). Returns
 * a NextResponse if the content is blocked, else null (proceed). */
async function screenAgentMarkdown(
  markdown: string,
  objectId: string,
  log: Logger
): Promise<NextResponse | null> {
  const safety = await getContentSafetyService().checkInputSafety(markdown, objectId);
  if (!safety.allowed) {
    log.warn("Agent write blocked by guardrails", {
      objectId,
      reason: safety.blockedReason,
      categories: safety.blockedCategories,
    });
    return NextResponse.json(
      {
        error: "Content blocked by safety policy",
        message: safety.blockedMessage ?? "The proposed content was blocked.",
      },
      { status: 422 }
    );
  }
  // FAIL CLOSED on degraded guardrails. The shared guardrails service fails OPEN
  // (returns allowed:true) when an AWS error/timeout/throttle prevents evaluation
  // — acceptable for latency-sensitive chat, but NOT for unscreened agent content
  // writing directly into a live K-12 document. A transient Bedrock failure must
  // never let hate speech / CSAM / etc. through here; reject and let the agent retry.
  if (safety.degraded) {
    log.error("Agent write rejected: guardrails unavailable (failing closed)", { objectId });
    return NextResponse.json(
      {
        error: "Safety screening unavailable",
        message: "Content could not be safety-screened right now. Please retry shortly.",
      },
      { status: 503 }
    );
  }
  // PII: detect + log only. A document keeps its real text; never tokenize-replace.
  try {
    const entities = await getPIITokenizationService().detectPII(markdown);
    if (entities.length > 0) {
      log.warn("PII detected in agent document write", { objectId, piiCount: entities.length });
    }
  } catch (piiError) {
    log.warn("PII detection failed (non-fatal)", {
      error: piiError instanceof Error ? piiError.message : String(piiError),
    });
  }
  return null;
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

    const req = await getUserRequester(requestId);
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

    const blocked = await screenAgentMarkdown(markdown, loaded.obj.id, log);
    if (blocked) {
      timer({ status: "error" });
      return blocked;
    }

    await applyAgentEdit({ objectId: loaded.obj.id, markdown, agentId, mode });

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
