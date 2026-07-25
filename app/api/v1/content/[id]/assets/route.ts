/**
 * Atrium immutable authored assets (#1284).
 *
 * GET  /api/v1/content/:id/assets — permission-checked metadata list
 * POST /api/v1/content/:id/assets — reserve a direct-to-S3 upload
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import {
  createApiResponse,
  createErrorResponse,
  parseRequestBody,
  requireScope,
  withApiAuth,
} from "@/lib/api";
import {
  contentAssetService,
  hashIdempotencyRequest,
  idempotencyScope,
  recordContentAudit,
  requesterFromApiAuth,
  validateIdempotencyKey,
} from "@/lib/content";
import { contentErrorToResponse, resolveRestRequester } from "@/lib/content/rest";
import { assertContentAuthoringCapability } from "@/lib/content/surface-helpers";
import { createLogger } from "@/lib/logger";

const initiateAssetSchema = z
  .object({
    filename: z.string().min(1).max(255),
    contentType: z.enum(["image/png", "image/jpeg", "image/webp"]),
    byteLength: z.number().int().positive().max(20 * 1024 * 1024),
    sha256: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    purpose: z.enum(["capture_step", "document_image"]),
    width: z.number().int().positive().max(12_000).optional(),
    height: z.number().int().positive().max(12_000).optional(),
  })
  .strict();

export const GET = withApiAuth(
  async (_request: NextRequest, auth, requestId, params) => {
    const scopeError = requireScope(auth, "content:read", requestId);
    if (scopeError) return scopeError;
    const objectId = params.id;
    if (!objectId) {
      return createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        "Missing content id"
      );
    }
    try {
      const req = await requesterFromApiAuth(auth);
      const assets = await contentAssetService.list(req, objectId);
      return createApiResponse(
        { data: assets, meta: { requestId, count: assets.length } },
        requestId
      );
    } catch (error) {
      return contentErrorToResponse(error, requestId);
    }
  }
);

export const POST = withApiAuth(
  async (request: NextRequest, auth, requestId, params) => {
    const scopeError = requireScope(auth, "content:update", requestId);
    if (scopeError) return scopeError;
    const objectId = params.id;
    if (!objectId) {
      return createErrorResponse(
        requestId,
        400,
        "VALIDATION_ERROR",
        "Missing content id"
      );
    }
    const parsed = await parseRequestBody(
      request,
      initiateAssetSchema,
      requestId
    );
    if (parsed instanceof Response) return parsed;
    const rawIdempotencyKey = request.headers.get("idempotency-key");
    if (
      rawIdempotencyKey !== null &&
      !validateIdempotencyKey(rawIdempotencyKey)
    ) {
      return createErrorResponse(
        requestId,
        400,
        "INVALID_IDEMPOTENCY_KEY",
        "Idempotency-Key must contain 1-255 visible ASCII characters"
      );
    }
    const canonicalRoute = `/api/v1/content/${objectId}/assets`;
    const initiationIdempotency =
      rawIdempotencyKey === null
        ? undefined
        : {
            keyHash: hashIdempotencyRequest(
              idempotencyScope(
                auth,
                request,
                canonicalRoute,
                rawIdempotencyKey
              )
            ),
            requestHash: hashIdempotencyRequest(parsed.data),
          };
    const resolved = await resolveRestRequester(auth, requestId);
    if ("response" in resolved) return resolved.response;
    const { req } = resolved;
    const log = createLogger({
      requestId,
      route: "api.v1.content.assets.initiate",
    });
    try {
      await assertContentAuthoringCapability(auth);
      const result = await contentAssetService.initiate(
        req,
        objectId,
        parsed.data,
        initiationIdempotency
      );
      const { asset } = result;
      void recordContentAudit({
        req,
        action: "initiate_asset",
        surface: "rest",
        objectId,
        outcome: "ok",
        details: { assetId: asset.id },
        requestId,
      });
      log.info("Initiated Atrium asset upload", {
        objectId,
        assetId: asset.id,
      });
      const response = createApiResponse(
        { data: asset, meta: { requestId } },
        requestId,
        201
      );
      if (result.replayed) {
        response.headers.set("Idempotency-Replayed", "true");
      }
      return response;
    } catch (error) {
      void recordContentAudit({
        req,
        action: "initiate_asset",
        surface: "rest",
        objectId,
        outcome: "error",
        error: error instanceof Error ? error.message : String(error),
        requestId,
      });
      return contentErrorToResponse(error, requestId);
    }
  }
);
