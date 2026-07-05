/**
 * Atrium OKF Import Endpoint (Issue #1103, Phase 8 §36.4)
 * POST /api/v1/content/import/okf — import an OKF bundle into Atrium content
 *
 * Mirrors the MCP `import_okf` tool. Requires `content:create`. Imported objects
 * are agent-authored (`actor_kind = 'agent'`) and created private + draft — the
 * import service attributes every write to the seeded `atrium-importer` identity,
 * regardless of who triggered the import (the caller is recorded in the audit row).
 */

import { NextRequest } from "next/server";
import {
  withApiAuth,
  requireScope,
  createApiResponse,
  parseRequestBody,
} from "@/lib/api";
import { z } from "zod";
import { okfImportService, recordContentAudit } from "@/lib/content";
import {
  contentErrorToResponse,
  resolveRestRequester,
} from "@/lib/content/rest";
import {
  assertContentAuthoringCapability,
  resolveCollectionId,
} from "@/lib/content/surface-helpers";
import { createLogger } from "@/lib/logger";

const importBodySchema = z.object({
  files: z
    .array(z.object({ path: z.string().min(1), content: z.string() }))
    .min(1),
  targetCollectionId: z.string().min(1).max(200).optional(),
});

export const POST = withApiAuth(async (request: NextRequest, auth, requestId) => {
  const scopeError = requireScope(auth, "content:create", requestId);
  if (scopeError) return scopeError;

  const log = createLogger({ requestId, route: "api.v1.content.import.okf" });

  const parsedBody = await parseRequestBody(request, importBodySchema, requestId);
  if (parsedBody instanceof Response) return parsedBody;
  const input = parsedBody.data;

  const resolved = await resolveRestRequester(auth, requestId);
  if ("response" in resolved) return resolved.response;
  const { req } = resolved;

  try {
    // Import creates content — session humans must ALSO hold the atrium-content
    // capability (scope alone is the wildcard ["*"] for a session); sk-/OIDC
    // callers are gated by the content:create scope above.
    await assertContentAuthoringCapability(auth);
    const targetCollectionId = input.targetCollectionId
      ? await resolveCollectionId(input.targetCollectionId)
      : undefined;
    const result = await okfImportService.importBundle(req, {
      files: input.files,
      targetCollectionId,
    });
    void recordContentAudit({
      req,
      action: "import_okf",
      surface: "rest",
      objectId: null,
      destination: "okf",
      outcome: "ok",
      requestId,
    });
    log.info("Imported OKF bundle via REST", {
      rootCollectionId: result.rootCollectionId,
      objectCount: result.objectCount,
    });
    return createApiResponse(
      {
        data: {
          rootCollectionId: result.rootCollectionId,
          collectionsCreated: result.collectionsCreated,
          objectCount: result.objectCount,
          objects: result.objects,
        },
        meta: { requestId },
      },
      requestId,
      201
    );
  } catch (err) {
    void recordContentAudit({
      req,
      action: "import_okf",
      surface: "rest",
      objectId: null,
      destination: "okf",
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
      requestId,
    });
    return contentErrorToResponse(err, requestId);
  }
});
