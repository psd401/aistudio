/**
 * Same-origin Atrium asset reader (#1284).
 *
 * This is the one /api/v1 content route that intentionally permits anonymous
 * requests. The service masks existence and serves a guest only when the asset
 * is referenced by the live public_web version of a public object.
 */

import { NextRequest, NextResponse } from "next/server";
import { getOptionalRequester } from "@/actions/db/atrium/requester";
import {
  authenticateRequest,
  createErrorResponse,
  requireScope,
} from "@/lib/api";
import {
  contentAssetService,
  requesterFromApiAuth,
  type Requester,
} from "@/lib/content";
import { contentErrorToResponse } from "@/lib/content/rest";
import { generateRequestId } from "@/lib/logger";

interface AssetBytesRouteContext {
  params: Promise<{ assetId?: string }>;
}

async function resolveRequester(
  request: NextRequest,
  requestId: string
): Promise<Requester | NextResponse> {
  if (request.headers.has("authorization")) {
    const auth = await authenticateRequest(request);
    if (!("userId" in auth)) return auth;
    const scopeError = requireScope(auth, "content:read", requestId);
    if (scopeError) return scopeError;
    try {
      return await requesterFromApiAuth(auth);
    } catch (error) {
      return contentErrorToResponse(error, requestId);
    }
  }
  return getOptionalRequester(requestId);
}

export async function GET(
  request: NextRequest,
  context: AssetBytesRouteContext
): Promise<NextResponse> {
  const requestId = generateRequestId();
  const { assetId } = await context.params;
  if (!assetId) {
    return createErrorResponse(
      requestId,
      400,
      "VALIDATION_ERROR",
      "Missing asset id"
    );
  }
  const requester = await resolveRequester(request, requestId);
  if (requester instanceof NextResponse) return requester;
  try {
    const asset = await contentAssetService.readBytes(requester, assetId);
    if (request.headers.get("if-none-match") === asset.etag) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          ETag: asset.etag,
          "Cache-Control": "private, no-store",
          "X-Request-Id": requestId,
        },
      });
    }
    return new NextResponse(Buffer.from(asset.bytes), {
      status: 200,
      headers: {
        "Content-Type": asset.contentType,
        "Content-Length": String(asset.bytes.byteLength),
        "Content-Disposition": "inline",
        "Cache-Control": "private, no-store",
        ETag: asset.etag,
        "X-Content-Type-Options": "nosniff",
        "X-Request-Id": requestId,
      },
    });
  } catch (error) {
    return contentErrorToResponse(error, requestId);
  }
}
