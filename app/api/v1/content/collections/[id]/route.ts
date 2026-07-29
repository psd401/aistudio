/**
 * Atrium collection mutation endpoint (#1438).
 *
 * PATCH covers rename, reorder, move, default policy changes, recursive archive,
 * and recursive restore. The shared service enforces district admin authority
 * and owner-bound private hierarchies.
 */

import { NextRequest } from "next/server";
import {
  createApiResponse,
  createErrorResponse,
  parseRequestBody,
  requireScope,
  withApiAuth,
} from "@/lib/api";
import { collectionManagementService } from "@/lib/content";
import {
  contentErrorToResponse,
  resolveRestRequester,
  updateCollectionBodySchema,
} from "@/lib/content/rest";
import { assertContentAuthoringCapability } from "@/lib/content/surface-helpers";

export const PATCH = withApiAuth(
  async (request: NextRequest, auth, requestId, params) => {
    const scopeError = requireScope(auth, "content:update", requestId);
    if (scopeError) return scopeError;
    const id = params.id;
    if (!id) {
      return createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        "Missing collection id"
      );
    }

    const parsedBody = await parseRequestBody(
      request,
      updateCollectionBodySchema,
      requestId
    );
    if (parsedBody instanceof Response) return parsedBody;

    const resolved = await resolveRestRequester(auth, requestId);
    if ("response" in resolved) return resolved.response;

    try {
      await assertContentAuthoringCapability(auth);
      const collection = await collectionManagementService.update(
        resolved.req,
        id,
        parsedBody.data,
        { surface: "rest", requestId }
      );
      return createApiResponse(
        { data: collection, meta: { requestId } },
        requestId
      );
    } catch (error) {
      return contentErrorToResponse(error, requestId);
    }
  }
);
