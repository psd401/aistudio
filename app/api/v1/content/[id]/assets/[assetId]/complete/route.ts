/** Complete, validate, and normalize an Atrium authored asset upload (#1284). */

import { NextRequest } from "next/server";
import { z } from "zod";
import {
  createApiResponse,
  createErrorResponse,
  parseRequestBody,
  requireScope,
  withApiAuth,
} from "@/lib/api";
import { contentAssetService, recordContentAudit } from "@/lib/content";
import { contentErrorToResponse, resolveRestRequester } from "@/lib/content/rest";
import { assertContentAuthoringCapability } from "@/lib/content/surface-helpers";
import { createLogger } from "@/lib/logger";

const completeAssetSchema = z
  .object({
    sha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    etag: z.string().min(1).max(512).optional(),
  })
  .strict();

export const POST = withApiAuth(
  async (request: NextRequest, auth, requestId, params) => {
    const scopeError = requireScope(auth, "content:update", requestId);
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
    const parsed = await parseRequestBody(
      request,
      completeAssetSchema,
      requestId
    );
    if (parsed instanceof Response) return parsed;
    const resolved = await resolveRestRequester(auth, requestId);
    if ("response" in resolved) return resolved.response;
    const { req } = resolved;
    const log = createLogger({
      requestId,
      route: "api.v1.content.assets.complete",
    });
    try {
      await assertContentAuthoringCapability(auth);
      const asset = await contentAssetService.complete(
        req,
        objectId,
        assetId,
        parsed.data
      );
      void recordContentAudit({
        req,
        action: "complete_asset",
        surface: "rest",
        objectId,
        outcome: "ok",
        details: { assetId },
        requestId,
      });
      log.info("Completed Atrium asset upload", { objectId, assetId });
      return createApiResponse(
        { data: asset, meta: { requestId } },
        requestId
      );
    } catch (error) {
      void recordContentAudit({
        req,
        action: "complete_asset",
        surface: "rest",
        objectId,
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
        details: { assetId },
        requestId,
      });
      return contentErrorToResponse(error, requestId);
    }
  }
);
