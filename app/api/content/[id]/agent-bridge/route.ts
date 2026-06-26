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
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserRequester } from "@/actions/db/atrium/requester";
import { contentService } from "@/lib/content/content-service";
import { visibilityService } from "@/lib/content/visibility-service";
import { canEdit } from "@/lib/content/helpers";
import { getContentSafetyService, getPIITokenizationService } from "@/lib/safety";
import { applyAgentEdit, type AgentEditMode } from "@/lib/content/collab/apply-agent-edit";

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

    const body = (await request.json().catch(() => ({}))) as BridgeBody;
    const markdown = typeof body.markdown === "string" ? body.markdown : "";
    if (!markdown.trim()) {
      timer({ status: "error" });
      return NextResponse.json({ error: "markdown is required" }, { status: 400 });
    }
    const mode = parseMode(body.mode);
    const agentId = (request.headers.get("x-agent-id") || "agent").trim() || "agent";

    const req = await getUserRequester(requestId);
    const loaded = await loadEditableObject(id, req);
    if ("error" in loaded) {
      timer({ status: "error" });
      return loaded.error;
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
