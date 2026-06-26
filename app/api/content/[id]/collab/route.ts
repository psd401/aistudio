/**
 * Atrium collab session token endpoint (#1051)
 *
 * GET /api/content/[id]/collab — mints a short-TTL token authorizing the caller to
 * open the document's collaboration websocket. The websocket itself carries no
 * ambient trust; authorization is this explicit, per-document, expiring grant that
 * also encodes write permission (read-only viewers get a token with w=false and
 * the collab server sets connection.readOnly).
 *
 * `id` may be a content object id or slug; the response returns the resolved
 * `docName` (the Yjs document name = object id) the client must connect with.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserRequester } from "@/actions/db/atrium/requester";
import { contentService } from "@/lib/content/content-service";
import { visibilityService } from "@/lib/content/visibility-service";
import { canEdit } from "@/lib/content/helpers";
import { signCollabToken } from "@/lib/content/collab/collab-token";

const COLLAB_WS_PATH = "/api/content/collab";

async function getHandler(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("GET /api/content/[id]/collab");
  const log = createLogger({ requestId, endpoint: "GET /api/content/[id]/collab" });

  try {
    const { id } = await params;

    const session = await getServerSession();
    if (!session?.sub) {
      timer({ status: "error" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const req = await getUserRequester(requestId);
    const obj = await contentService.loadByIdOrSlug(id);
    // 404 (not 403) when not viewable: a document object id/slug is not enumerable.
    if (!obj) {
      timer({ status: "error" });
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const viewable = await visibilityService.canView(req, {
      id: obj.id,
      ownerUserId: obj.ownerUserId,
      visibilityLevel: obj.visibilityLevel,
    });
    if (!viewable) {
      timer({ status: "error" });
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (req.kind !== "user" || req.userId == null) {
      // Phase 1 collab is a logged-in-human surface; non-user requesters cannot
      // open an interactive editor session.
      timer({ status: "error" });
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const mayWrite = canEdit(req, obj.ownerUserId);
    const token = await signCollabToken({
      sub: String(req.userId),
      oid: obj.id,
      w: mayWrite,
    });

    timer({ status: "success" });
    log.info("Issued collab token", { objectId: obj.id, mayWrite });
    return NextResponse.json({
      token,
      docName: obj.id,
      wsPath: COLLAB_WS_PATH,
      canEdit: mayWrite,
    });
  } catch (error) {
    timer({ status: "error" });
    log.error("Failed to issue collab token", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export { getHandler as GET };
