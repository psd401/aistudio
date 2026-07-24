/** Permission-checked Atrium asset metadata (#1284). */

import { NextRequest } from "next/server";
import {
  createApiResponse,
  createErrorResponse,
  requireScope,
  withApiAuth,
} from "@/lib/api";
import { contentAssetService, requesterFromApiAuth } from "@/lib/content";
import { contentErrorToResponse } from "@/lib/content/rest";

export const GET = withApiAuth(
  async (_request: NextRequest, auth, requestId, params) => {
    const scopeError = requireScope(auth, "content:read", requestId);
    if (scopeError) return scopeError;
    const objectId = params.id;
    const assetId = params.assetId;
    if (!objectId || !assetId) {
      return createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        "Missing content or asset id"
      );
    }
    try {
      const req = await requesterFromApiAuth(auth);
      const asset = await contentAssetService.get(req, objectId, assetId);
      return createApiResponse(
        { data: asset, meta: { requestId } },
        requestId
      );
    } catch (error) {
      return contentErrorToResponse(error, requestId);
    }
  }
);
