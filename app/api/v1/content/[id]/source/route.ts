/** Current committed Atrium source alias (#1288). */

import { NextRequest, NextResponse } from "next/server";
import {
  createApiResponse,
  createErrorResponse,
  requireScope,
  withApiAuth,
} from "@/lib/api";
import {
  contentSourceEtag,
  contentSourceService,
  ifNoneMatchIncludes,
  requesterFromApiAuth,
} from "@/lib/content";
import { contentErrorToResponse } from "@/lib/content/rest";

export const GET = withApiAuth(async (request: NextRequest, auth, requestId, params) => {
  const scopeError = requireScope(auth, "content:read", requestId);
  if (scopeError) return scopeError;
  if (!params.id) {
    return createErrorResponse(
      requestId,
      400,
      "VALIDATION_ERROR",
      "Missing content id"
    );
  }

  try {
    const req = await requesterFromApiAuth(auth);
    const version = await contentSourceService.resolve(req, params.id);
    const etag = contentSourceEtag(version.id);
    if (ifNoneMatchIncludes(request.headers.get("if-none-match"), etag)) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: etag,
          "Cache-Control": "private, no-store",
          "X-Request-Id": requestId,
        },
      });
    }
    const source = await contentSourceService.loadResolved(version);
    const response = createApiResponse(
      { data: source, meta: { requestId } },
      requestId
    );
    response.headers.set("ETag", etag);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  } catch (error) {
    return contentErrorToResponse(error, requestId);
  }
});
