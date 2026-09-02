"use server"

/**
 * Human-facing Atrium collection management actions (#1438).
 *
 * Authorization remains in the shared service: administrators may manage the
 * district hierarchy, while every Atrium author may manage only their own
 * owner-bound private hierarchy.
 */

import {
  createLogger,
  generateRequestId,
  sanitizeForLogging,
  startTimer,
} from "@/lib/logger";
import { createSuccess, ErrorFactories, handleError } from "@/lib/error-utils";
import { getServerSession } from "@/lib/auth/server-session";
import {
  collectionManagementService,
  ContentError,
  ValidationError,
} from "@/lib/content";
import {
  createCollectionBodySchema,
  updateCollectionBodySchema,
} from "@/lib/content/rest";
import type {
  CollectionDTO,
  CreateCollectionInput,
  UpdateCollectionInput,
} from "@/lib/content";
import type { ActionState } from "@/types";
import { hasCapabilityAccess } from "@/utils/roles";
import { getUserRequester } from "./requester";

async function authorizedRequester(requestId: string) {
  const session = await getServerSession();
  const requester = await getUserRequester(requestId, session);
  if (!(await hasCapabilityAccess("atrium-content", session!.sub))) {
    throw ErrorFactories.authzToolAccessDenied("atrium-content");
  }
  return requester;
}

export async function listManageableCollectionsAction(
  mode: "admin" | "private" = "admin"
): Promise<
  ActionState<CollectionDTO[]>
> {
  const requestId = generateRequestId();
  const timer = startTimer("listManageableCollectionsAction");
  const log = createLogger({
    requestId,
    action: "listManageableCollectionsAction",
  });
  try {
    log.info("Action started: list manageable collections");
    const requester = await authorizedRequester(requestId);
    const collections =
      mode === "private"
        ? await collectionManagementService.listOwnedPrivate(requester)
        : await collectionManagementService.listManageable(requester);
    timer({ status: "success" });
    log.info("Manageable collections loaded", { count: collections.length });
    return createSuccess(collections, "Collections loaded");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to load collections", {
      context: "listManageableCollectionsAction",
      requestId,
      operation: "listManageableCollectionsAction",
    });
  }
}

export async function createCollectionAction(
  input: CreateCollectionInput
): Promise<ActionState<CollectionDTO>> {
  const requestId = generateRequestId();
  const timer = startTimer("createCollectionAction");
  const log = createLogger({ requestId, action: "createCollectionAction" });
  try {
    log.info("Action started: create collection", {
      input: sanitizeForLogging({
        ...input,
        grants: input.grants?.length ?? 0,
      }),
    });
    const requester = await authorizedRequester(requestId);
    const parsed = createCollectionBodySchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid collection input", {
        issues: parsed.error.issues,
      });
    }
    const collection = await collectionManagementService.create(
      requester,
      parsed.data,
      { surface: "ui", requestId }
    );
    timer({ status: "success" });
    log.info("Collection created", { collectionId: collection.id });
    return createSuccess(collection, "Collection created");
  } catch (error) {
    timer({ status: "error" });
    return handleError(
      error,
      error instanceof ContentError
        ? error.message
        : "Failed to create collection",
      {
        context: "createCollectionAction",
        requestId,
        operation: "createCollectionAction",
      }
    );
  }
}

export async function updateCollectionAction(
  collectionId: string,
  input: UpdateCollectionInput
): Promise<ActionState<CollectionDTO>> {
  const requestId = generateRequestId();
  const timer = startTimer("updateCollectionAction");
  const log = createLogger({ requestId, action: "updateCollectionAction" });
  try {
    log.info("Action started: update collection", {
      collectionId: sanitizeForLogging(collectionId),
      input: sanitizeForLogging({
        ...input,
        grants: input.grants?.length ?? undefined,
      }),
    });
    // Authenticate and capability-gate before branching on attacker-controlled
    // identifiers. Besides keeping logged-out responses consistently at 401,
    // this prevents validation behavior from becoming an authorization oracle.
    const requester = await authorizedRequester(requestId);
    if (!collectionId) {
      throw ErrorFactories.missingRequiredField("collectionId");
    }
    const parsed = updateCollectionBodySchema.safeParse(input);
    if (!parsed.success) {
      throw new ValidationError("Invalid collection update", {
        issues: parsed.error.issues,
      });
    }
    const collection = await collectionManagementService.update(
      requester,
      collectionId,
      parsed.data,
      { surface: "ui", requestId }
    );
    timer({ status: "success" });
    log.info("Collection updated", { collectionId: collection.id });
    return createSuccess(collection, "Collection updated");
  } catch (error) {
    timer({ status: "error" });
    return handleError(
      error,
      error instanceof ContentError
        ? error.message
        : "Failed to update collection",
      {
        context: "updateCollectionAction",
        requestId,
        operation: "updateCollectionAction",
      }
    );
  }
}

/**
 * Drag-reorder in the sidebar tree: move one collection to `toIndex` among its
 * live siblings. The service resolves the group (same parent and owner) and
 * `assertMayManage`s the row before anything else, so a caller who may not see
 * it gets the masked "not found" and never learns its neighbours.
 */
export async function moveCollectionAction(
  collectionId: string,
  toIndex: number
): Promise<ActionState<null>> {
  const requestId = generateRequestId();
  const timer = startTimer("moveCollectionAction");
  const log = createLogger({ requestId, action: "moveCollectionAction" });
  try {
    log.info("Action started: move collection", {
      collectionId: sanitizeForLogging(collectionId),
      toIndex,
    });
    // Authenticate and capability-gate before branching on caller-controlled
    // input, for the same reasons as updateCollectionAction.
    const requester = await authorizedRequester(requestId);
    if (typeof collectionId !== "string" || !collectionId) {
      throw ErrorFactories.missingRequiredField("collectionId");
    }
    if (!Number.isInteger(toIndex) || toIndex < 0) {
      throw new ValidationError("toIndex must be a non-negative integer");
    }
    await collectionManagementService.move(requester, collectionId, toIndex, {
      surface: "ui",
      requestId,
    });
    timer({ status: "success" });
    log.info("Collection moved", { collectionId, toIndex });
    return createSuccess(null, "Collection moved");
  } catch (error) {
    timer({ status: "error" });
    return handleError(
      error,
      error instanceof ContentError ? error.message : "Failed to move collection",
      {
        context: "moveCollectionAction",
        requestId,
        operation: "moveCollectionAction",
      }
    );
  }
}
