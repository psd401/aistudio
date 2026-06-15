"use server"

import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging,
} from "@/lib/logger"
import {
  handleError,
  ErrorFactories,
  createSuccess,
} from "@/lib/error-utils"
import type { ActionState } from "@/types"
import { requireRole } from "@/lib/auth/role-helpers"
import {
  getCapabilities,
  getCapabilityById,
  getCapabilityByIdentifier,
  createCapability,
  updateCapability,
  setCapabilityActive,
  getRoleCapabilities,
  getCapabilityRoleIds,
  assignCapabilityToRole,
  removeCapabilityFromRole,
} from "@/lib/db/drizzle"
import type { Capability } from "@/lib/db/schema"
import { revalidatePath } from "next/cache"

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

export interface CreateCapabilityInput {
  identifier: string
  name: string
  description?: string | null
}

export interface UpdateCapabilityInput {
  name?: string
  description?: string | null
  isActive?: boolean
}

/**
 * List all capabilities (active and inactive) for the admin UI.
 */
export async function getCapabilitiesAction(): Promise<
  ActionState<Capability[]>
> {
  const requestId = generateRequestId()
  const timer = startTimer("getCapabilitiesAction")

  try {
    await requireRole("administrator")
    const capabilities = await getCapabilities()
    timer({ status: "success" })
    return createSuccess(capabilities as Capability[], "Capabilities loaded")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load capabilities", {
      context: "getCapabilitiesAction",
      requestId,
      operation: "getCapabilitiesAction",
    })
  }
}

/**
 * Create a manual capability.
 *
 * Manually-created capabilities are always `source: 'manual'`. Identifiers must
 * be unique, kebab/dot-case, and immutable after creation.
 */
export async function createCapabilityAction(
  input: CreateCapabilityInput
): Promise<ActionState<Capability>> {
  const requestId = generateRequestId()
  const timer = startTimer("createCapabilityAction")
  const log = createLogger({ requestId, action: "createCapabilityAction" })

  try {
    log.info("Creating capability", { params: sanitizeForLogging(input) })
    await requireRole("administrator")

    const identifier = input.identifier?.trim()
    const name = input.name?.trim()

    if (!identifier) {
      throw ErrorFactories.missingRequiredField("identifier")
    }
    if (!name) {
      throw ErrorFactories.missingRequiredField("name")
    }
    if (!IDENTIFIER_PATTERN.test(identifier)) {
      throw ErrorFactories.validationFailed([
        {
          field: "identifier",
          message:
            "Identifier must be lowercase alphanumeric and may contain '.', '-', '_'",
        },
      ])
    }

    const existing = await getCapabilityByIdentifier(identifier)
    if (existing) {
      throw ErrorFactories.validationFailed([
        { field: "identifier", message: "A capability with this identifier already exists" },
      ])
    }

    const created = await createCapability({
      identifier,
      name,
      description: input.description?.trim() || null,
      isActive: true,
      source: "manual",
    })

    revalidatePath("/admin/roles")
    timer({ status: "success" })
    return createSuccess(created as Capability, "Capability created")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to create capability", {
      context: "createCapabilityAction",
      requestId,
      operation: "createCapabilityAction",
    })
  }
}

/**
 * SECURITY: reject any name/description change to a code-managed capability.
 * Throws a validation error if the caller attempts to mutate a read-only field.
 */
function assertCodeFieldsUnchanged(
  input: UpdateCapabilityInput,
  existing: Capability
): void {
  if (input.name !== undefined && input.name.trim() !== existing.name) {
    throw ErrorFactories.validationFailed([
      {
        field: "name",
        message:
          "Name of a code-managed capability is read-only (managed by the code manifest)",
      },
    ])
  }
  if (
    input.description !== undefined &&
    (input.description?.trim() || null) !== (existing.description ?? null)
  ) {
    throw ErrorFactories.validationFailed([
      {
        field: "description",
        message:
          "Description of a code-managed capability is read-only (managed by the code manifest)",
      },
    ])
  }
}

/**
 * Build the set of allowed updates for a capability based on its source.
 * For `source: 'code'` only `isActive` is editable; for manual, all fields are.
 */
function buildCapabilityUpdates(
  input: UpdateCapabilityInput,
  existing: Capability
): UpdateCapabilityInput {
  const updates: UpdateCapabilityInput = {}

  if (existing.source === "code") {
    assertCodeFieldsUnchanged(input, existing)
  } else {
    if (input.name !== undefined) {
      const name = input.name.trim()
      if (!name) {
        throw ErrorFactories.missingRequiredField("name")
      }
      updates.name = name
    }
    if (input.description !== undefined) {
      updates.description = input.description?.trim() || null
    }
  }

  if (input.isActive !== undefined) {
    updates.isActive = input.isActive
  }

  return updates
}

/**
 * Update a capability.
 *
 * SECURITY: For `source: 'code'` capabilities, name/description are managed by the
 * code manifest and MUST NOT be editable through the admin API — only `isActive`
 * may change. This is enforced server-side here (not just in the UI).
 */
export async function updateCapabilityAction(
  id: number,
  input: UpdateCapabilityInput
): Promise<ActionState<Capability>> {
  const requestId = generateRequestId()
  const timer = startTimer("updateCapabilityAction")
  const log = createLogger({ requestId, action: "updateCapabilityAction" })

  try {
    log.info("Updating capability", {
      id,
      params: sanitizeForLogging(input),
    })
    await requireRole("administrator")

    const existing = await getCapabilityById(id)
    const updates = buildCapabilityUpdates(input, existing as Capability)

    const updated = await updateCapability(id, updates)
    revalidatePath("/admin/roles")
    timer({ status: "success" })
    return createSuccess(updated as Capability, "Capability updated")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to update capability", {
      context: "updateCapabilityAction",
      requestId,
      operation: "updateCapabilityAction",
    })
  }
}

/**
 * Enable or disable a capability (soft toggle of is_active).
 * Allowed for both code and manual capabilities.
 */
export async function setCapabilityActiveAction(
  id: number,
  isActive: boolean
): Promise<ActionState<Capability>> {
  const requestId = generateRequestId()
  const timer = startTimer("setCapabilityActiveAction")
  const log = createLogger({ requestId, action: "setCapabilityActiveAction" })

  try {
    log.info("Setting capability active state", { id, isActive })
    await requireRole("administrator")

    const updated = await setCapabilityActive(id, isActive)
    revalidatePath("/admin/roles")
    timer({ status: "success" })
    return createSuccess(
      updated as Capability,
      isActive ? "Capability enabled" : "Capability disabled"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to update capability state", {
      context: "setCapabilityActiveAction",
      requestId,
      operation: "setCapabilityActiveAction",
    })
  }
}

/**
 * Get the role IDs a capability is assigned to (for the admin assignment UI).
 */
export async function getCapabilityRoleIdsAction(
  capabilityId: number
): Promise<ActionState<number[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getCapabilityRoleIdsAction")

  try {
    await requireRole("administrator")
    const roleIds = await getCapabilityRoleIds(capabilityId)
    timer({ status: "success" })
    return createSuccess(roleIds, "Role assignments loaded")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load role assignments", {
      context: "getCapabilityRoleIdsAction",
      requestId,
      operation: "getCapabilityRoleIdsAction",
    })
  }
}

/**
 * Assign or unassign a capability to/from a role. Allowed for code and manual
 * capabilities alike — role assignment is always editable.
 */
export async function setCapabilityRoleAssignmentAction(
  capabilityId: number,
  roleId: number,
  assigned: boolean
): Promise<ActionState<{ assigned: boolean }>> {
  const requestId = generateRequestId()
  const timer = startTimer("setCapabilityRoleAssignmentAction")
  const log = createLogger({
    requestId,
    action: "setCapabilityRoleAssignmentAction",
  })

  try {
    log.info("Setting capability role assignment", {
      capabilityId,
      roleId,
      assigned,
    })
    await requireRole("administrator")

    // Validate the capability exists before mutating grants.
    await getCapabilityById(capabilityId)

    if (assigned) {
      await assignCapabilityToRole(roleId, capabilityId)
    } else {
      await removeCapabilityFromRole(roleId, capabilityId)
    }

    revalidatePath("/admin/roles")
    timer({ status: "success" })
    return createSuccess(
      { assigned },
      assigned ? "Capability assigned to role" : "Capability removed from role"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to update role assignment", {
      context: "setCapabilityRoleAssignmentAction",
      requestId,
      operation: "setCapabilityRoleAssignmentAction",
    })
  }
}

/**
 * Get the capabilities currently assigned to a role.
 */
export async function getRoleCapabilitiesAction(
  roleId: number
): Promise<ActionState<Capability[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getRoleCapabilitiesAction")

  try {
    await requireRole("administrator")
    const capabilities = await getRoleCapabilities(roleId)
    timer({ status: "success" })
    return createSuccess(
      capabilities as Capability[],
      "Role capabilities loaded"
    )
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to load role capabilities", {
      context: "getRoleCapabilitiesAction",
      requestId,
      operation: "getRoleCapabilitiesAction",
    })
  }
}
