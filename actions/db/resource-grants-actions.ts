"use server";

/**
 * Per-resource access grant management (Epic #1202 Phase 3, #1206).
 *
 * Admin-only server actions backing the grants editor on the model / assistant /
 * skill admin surfaces. A grant keys direct access on a single resource to a role
 * (by name) or a synced Google group (by email); zero grants = unrestricted. The
 * authoritative read gate lives in lib/db/drizzle/resource-access.ts
 * (userCanAccessResource / filterAccessibleResourceIds); these actions only
 * read/replace the grant rows.
 *
 * Grant management is admin-only in this phase. Group emails are normalized
 * (lowercased) on write; role names are stored as submitted and matched
 * case-insensitively downstream. Following the Atrium Phase 2 decision (#1205),
 * there is intentionally NO write-time validation that a submitted role/group
 * still exists — the read gate simply never matches a stale value.
 */

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger";
import { handleError, createSuccess, ErrorFactories } from "@/lib/error-utils";
import type { ActionState } from "@/types";
import { hasRole } from "@/utils/roles";
import { getCurrentUserAction } from "@/actions/db/get-current-user-action";
import { executeQuery } from "@/lib/db/drizzle-client";
import { asc } from "drizzle-orm";
import { roles } from "@/lib/db/schema";
import {
  RESOURCE_GRANT_TYPES,
  RESOURCE_GRANT_KINDS,
  type ResourceGrantType,
} from "@/lib/db/schema";
import {
  listResourceGrants,
  replaceResourceGrants,
  type ResourceGrant,
} from "@/lib/db/drizzle/resource-access";
import {
  listActiveGroupsForPicker,
  type GroupPickerOption,
} from "@/lib/groups/queries";

/** Selectable options for the grants editor pickers. */
export interface ResourceGrantOptions {
  /** Role names selectable for a `role` grant. */
  roles: string[];
  /** Active synced Google groups selectable for a `group` grant (value = email). */
  groups: GroupPickerOption[];
}

function isResourceGrantType(value: string): value is ResourceGrantType {
  return (RESOURCE_GRANT_TYPES as readonly string[]).includes(value);
}

/**
 * Coerce a client-supplied resource id to the form the resource type uses:
 * models/assistants are serial ints; skills are uuid strings. Returns null when
 * the id is unusable for the type (so callers 400 rather than write a bad row).
 */
function coerceResourceId(
  resourceType: ResourceGrantType,
  resourceId: number | string
): number | string | null {
  if (resourceType === "skill") {
    const id = String(resourceId).trim();
    return id.length > 0 ? id : null;
  }
  // model | assistant → positive integer
  const n = typeof resourceId === "number" ? resourceId : Number(resourceId);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Validate + normalize a submitted grant list into a well-typed set. */
function sanitizeSubmittedGrants(raw: unknown): ResourceGrant[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ResourceGrant[] = [];
  for (const g of raw) {
    if (!g || typeof g !== "object") return null;
    const kind = (g as { grantKind?: unknown }).grantKind;
    const value = (g as { grantValue?: unknown }).grantValue;
    if (
      typeof kind !== "string" ||
      !(RESOURCE_GRANT_KINDS as readonly string[]).includes(kind) ||
      typeof value !== "string"
    ) {
      return null;
    }
    out.push({ grantKind: kind as ResourceGrant["grantKind"], grantValue: value });
  }
  return out;
}

async function requireAdmin(): Promise<void> {
  if (!(await hasRole("administrator"))) {
    throw ErrorFactories.authzAdminRequired("manage resource access grants");
  }
}

/**
 * List the selectable role names + active groups for the grants editor pickers.
 * Admin-only. (Role names / group emails are the same values already surfaced on
 * every role-gated UI and the group-directory admin page — not sensitive.)
 */
export async function getResourceGrantOptionsAction(): Promise<
  ActionState<ResourceGrantOptions>
> {
  const requestId = generateRequestId();
  const timer = startTimer("getResourceGrantOptionsAction");
  const log = createLogger({ requestId, action: "getResourceGrantOptionsAction" });

  try {
    await requireAdmin();
    log.info("Loading resource grant options");

    const [roleRows, groupOptions] = await Promise.all([
      executeQuery(
        (db) => db.select({ name: roles.name }).from(roles).orderBy(asc(roles.name)),
        "getResourceGrantOptions.roles"
      ),
      listActiveGroupsForPicker(),
    ]);

    timer({ status: "success" });
    return createSuccess(
      { roles: roleRows.map((r) => r.name), groups: groupOptions },
      "Grant options loaded"
    );
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to load grant options", {
      context: "getResourceGrantOptionsAction",
      requestId,
      operation: "getResourceGrantOptionsAction",
    });
  }
}

/** Read a resource's current grants (admin-only). */
export async function getResourceGrantsAction(
  resourceType: string,
  resourceId: number | string
): Promise<ActionState<ResourceGrant[]>> {
  const requestId = generateRequestId();
  const timer = startTimer("getResourceGrantsAction");
  const log = createLogger({ requestId, action: "getResourceGrantsAction" });

  try {
    await requireAdmin();
    log.info("Loading resource grants", { resourceType, resourceId: String(resourceId) });

    if (!isResourceGrantType(resourceType)) {
      throw ErrorFactories.validationFailed([
        { field: "resourceType", message: "Unknown resource type" },
      ]);
    }
    const id = coerceResourceId(resourceType, resourceId);
    if (id === null) {
      throw ErrorFactories.validationFailed([
        { field: "resourceId", message: "Invalid resource id" },
      ]);
    }

    const grants = await listResourceGrants(resourceType, id);
    timer({ status: "success" });
    return createSuccess(grants, "Grants loaded");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to load grants", {
      context: "getResourceGrantsAction",
      requestId,
      operation: "getResourceGrantsAction",
    });
  }
}

/**
 * Replace ALL of a resource's grants with the submitted set (admin-only). An
 * empty set clears every grant (the resource becomes unrestricted). Returns the
 * resulting grants so the editor can re-render from server truth.
 */
export async function updateResourceGrantsAction(
  resourceType: string,
  resourceId: number | string,
  grants: unknown
): Promise<ActionState<ResourceGrant[]>> {
  const requestId = generateRequestId();
  const timer = startTimer("updateResourceGrantsAction");
  const log = createLogger({ requestId, action: "updateResourceGrantsAction" });

  try {
    await requireAdmin();

    if (!isResourceGrantType(resourceType)) {
      throw ErrorFactories.validationFailed([
        { field: "resourceType", message: "Unknown resource type" },
      ]);
    }
    const id = coerceResourceId(resourceType, resourceId);
    if (id === null) {
      throw ErrorFactories.validationFailed([
        { field: "resourceId", message: "Invalid resource id" },
      ]);
    }
    const sanitized = sanitizeSubmittedGrants(grants);
    if (sanitized === null) {
      throw ErrorFactories.validationFailed([
        { field: "grants", message: "Malformed grant list" },
      ]);
    }

    const current = await getCurrentUserAction();
    const createdBy = current.isSuccess ? current.data?.user?.id ?? null : null;

    log.info(
      "Replacing resource grants",
      sanitizeForLogging({ resourceType, resourceId: String(id), grantCount: sanitized.length })
    );

    // replaceResourceGrants normalizes (lowercases group emails, trims roles) +
    // de-dupes before the atomic delete-then-insert.
    await replaceResourceGrants(resourceType, id, sanitized, createdBy);

    const saved = await listResourceGrants(resourceType, id);
    timer({ status: "success" });
    return createSuccess(saved, "Access updated");
  } catch (error) {
    timer({ status: "error" });
    return handleError(error, "Failed to update grants", {
      context: "updateResourceGrantsAction",
      requestId,
      operation: "updateResourceGrantsAction",
    });
  }
}
