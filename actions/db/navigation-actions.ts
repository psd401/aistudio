"use server"

import {
  getNavigationItems,
  createNavigationItem,
  updateNavigationItem,
  deleteNavigationItem
} from "@/lib/db/drizzle"
import { ActionState } from "@/types"
import type { InsertNavigationItem, SelectNavigationItem } from "@/types/db-types"
import { getServerSession } from "@/lib/auth/server-session"
import { hasRole } from "@/utils/roles"
import {
  handleError,
  ErrorFactories,
  createSuccess
} from "@/lib/error-utils"
import {
  createLogger,
  generateRequestId,
  startTimer,
  sanitizeForLogging
} from "@/lib/logger"
// UUID import removed - using auto-increment IDs

// Parse an optional numeric field, throwing invalidInput on NaN.
// Returns undefined when the value is null/undefined (no conversion needed).
function parseOptionalNumericField(
  field: string,
  value: number | string | null | undefined
): number | undefined {
  if (value === undefined || value === null) {
    return undefined
  }
  const numValue = Number(value)
  if (Number.isNaN(numValue)) {
    throw ErrorFactories.invalidInput(field, value, 'Must be a valid number')
  }
  return numValue
}

type NavigationUpdateData = Partial<{
  label: string;
  icon: string;
  link: string | null;
  description: string | null;
  type: "link" | "section" | "page";
  // Clearable relation/role fields accept null so callers can REMOVE the gate.
  parentId: number | null;
  capabilityId: number | null;
  requiresRole: string | null;
  position: number;
  isActive: boolean;
}>

// Map string/typed fields (label, icon, link, description, type) onto the
// update payload, preserving the original null/undefined and type-narrowing
// rules.
function applyNavigationStringFields(
  data: Partial<InsertNavigationItem>,
  updateData: NavigationUpdateData
): void {
  if (data.label !== undefined) updateData.label = data.label
  if (data.icon !== undefined) updateData.icon = data.icon
  if (data.link !== undefined) updateData.link = data.link ?? null
  if (data.description !== undefined) updateData.description = data.description ?? null
  if (data.type !== undefined && (data.type === "link" || data.type === "section" || data.type === "page")) updateData.type = data.type
}

// Map relational/role fields (parentId, capabilityId, requiresRole) onto the
// update payload. An explicit null is PRESERVED (not omitted) so callers can
// clear the gate — e.g. ungate a nav item by setting capabilityId to null.
// Only `undefined` (field absent) is treated as "leave unchanged".
function applyNavigationRelationFields(
  data: Partial<InsertNavigationItem>,
  updateData: NavigationUpdateData
): void {
  if (data.parentId !== undefined) updateData.parentId = data.parentId ?? null
  if (data.capabilityId !== undefined) updateData.capabilityId = data.capabilityId ?? null
  if (data.requiresRole !== undefined) updateData.requiresRole = data.requiresRole ?? null
}

// Map simple scalar fields (position, isActive) onto the update payload.
function applyNavigationScalarFields(
  data: Partial<InsertNavigationItem>,
  updateData: NavigationUpdateData
): void {
  if (data.position !== undefined) updateData.position = data.position
  if (data.isActive !== undefined) updateData.isActive = data.isActive
}

// Build the database update payload from a partial input. Absent fields
// (undefined) are omitted ("leave unchanged"); explicit null is PRESERVED so a
// caller can clear a relation/gate — e.g. ungate a nav item via capabilityId:
// null. See applyNavigationRelationFields for the null-preservation detail.
function buildNavigationUpdateData(
  data: Partial<InsertNavigationItem>
): NavigationUpdateData {
  const updateData: NavigationUpdateData = {}

  applyNavigationStringFields(data, updateData)
  applyNavigationRelationFields(data, updateData)
  applyNavigationScalarFields(data, updateData)

  return updateData
}

export async function getNavigationItemsAction(): Promise<ActionState<SelectNavigationItem[]>> {
  const requestId = generateRequestId()
  const timer = startTimer("getNavigationItems")
  const log = createLogger({ requestId, action: "getNavigationItems" })
  
  try {
    log.info("Action started: Getting navigation items")
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized navigation items access attempt")
      throw ErrorFactories.authNoSession()
    }
    
    log.debug("User authenticated", { userId: session.sub })
    
    log.debug("Fetching navigation items from database")
    const items = await getNavigationItems(false) // Get all items, not just active
    
    log.info("Navigation items retrieved successfully", {
      itemCount: items.length,
      activeCount: items.filter(i => i.isActive).length
    })
    
    timer({ status: "success", count: items.length })

    // Transform to SelectNavigationItem type
    const transformedItems: SelectNavigationItem[] = items.map(item => ({
      id: item.id,
      label: item.label,
      icon: item.icon,
      link: item.link ?? null,
      description: item.description ?? null,
      type: item.type,
      parentId: item.parentId ?? null,
      capabilityId: item.capabilityId ?? null,
      requiresRole: item.requiresRole ?? null,
      position: item.position,
      isActive: item.isActive,
      createdAt: item.createdAt,
      contentObjectId: item.contentObjectId ?? null
    }))

    return createSuccess(transformedItems, "Navigation items retrieved successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to get navigation items. Please try again or contact support.", {
      context: "getNavigationItems",
      requestId,
      operation: "getNavigationItems"
    })
  }
}

export async function createNavigationItemAction(
  data: InsertNavigationItem
): Promise<ActionState<SelectNavigationItem>> {
  const requestId = generateRequestId()
  const timer = startTimer("createNavigationItem")
  const log = createLogger({ requestId, action: "createNavigationItem" })
  
  try {
    log.info("Action started: Creating navigation item", {
      label: data.label,
      type: data.type || 'page',
      link: data.link
    })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized navigation item creation attempt")
      throw ErrorFactories.authNoSession()
    }

    // Navigation is GLOBAL shared state; managing it is an administrative
    // function. Gate on administrator, not mere authentication (REV-COR-039).
    if (!(await hasRole("administrator"))) {
      log.warn("Non-admin attempted to create a navigation item", { userId: session.sub })
      throw ErrorFactories.authzInsufficientPermissions("administrator")
    }
    
    log.debug("User authenticated", { userId: session.sub })
    
    log.info("Creating navigation item in database", {
      label: data.label,
      type: data.type,
      isActive: data.isActive ?? true
    })
    
    // Validate numeric conversions
    const parentId = parseOptionalNumericField('parentId', data.parentId)
    const capabilityId = parseOptionalNumericField('capabilityId', data.capabilityId)

    const newItem = await createNavigationItem({
      label: data.label,
      icon: data.icon,
      link: data.link ?? undefined,
      description: data.description ?? undefined,
      type: data.type || 'page',
      parentId,
      capabilityId,
      requiresRole: data.requiresRole ?? undefined,
      position: data.position,
      isActive: data.isActive ?? true
    })
    
    log.info("Navigation item created successfully", {
      itemId: newItem.id,
      label: newItem.label
    })
    
    timer({ status: "success", itemId: newItem.id })

    // Transform to SelectNavigationItem type
    const transformedItem: SelectNavigationItem = {
      id: newItem.id,
      label: newItem.label,
      icon: newItem.icon,
      link: newItem.link ?? null,
      description: newItem.description ?? null,
      type: newItem.type,
      parentId: newItem.parentId ?? null,
      capabilityId: newItem.capabilityId ?? null,
      requiresRole: newItem.requiresRole ?? null,
      position: newItem.position,
      isActive: newItem.isActive,
      createdAt: newItem.createdAt,
      // This action does not create content-linked nav items; the Atrium
      // migration (#1058) seeds those. Default to null here.
      contentObjectId: null
    }

    return createSuccess(transformedItem, "Navigation item created successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to create navigation item. Please try again or contact support.", {
      context: "createNavigationItem",
      requestId,
      operation: "createNavigationItem",
      metadata: sanitizeForLogging({ label: data.label, type: data.type }) as Record<string, unknown>
    })
  }
}

export async function updateNavigationItemAction(
  id: string | number,
  data: Partial<InsertNavigationItem>
): Promise<ActionState<SelectNavigationItem>> {
  const requestId = generateRequestId()
  const timer = startTimer("updateNavigationItem")
  const log = createLogger({ requestId, action: "updateNavigationItem" })
  
  try {
    log.info("Action started: Updating navigation item", {
      itemId: id,
      updates: sanitizeForLogging(data)
    })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized navigation item update attempt")
      throw ErrorFactories.authNoSession()
    }

    // Admin-only: updating a nav item can clear its capability/role gate
    // (ungate a privileged entry) — a privilege-escalation surface (REV-COR-039).
    if (!(await hasRole("administrator"))) {
      log.warn("Non-admin attempted to update a navigation item", { userId: session.sub })
      throw ErrorFactories.authzInsufficientPermissions("administrator")
    }
    
    log.debug("User authenticated", { userId: session.sub })
    // Convert null values to undefined for updateNavigationItem
    const updateData = buildNavigationUpdateData(data)

    log.info("Updating navigation item in database", {
      itemId: id,
      fieldsUpdated: Object.keys(updateData).length
    })

    // Validate ID conversion
    const numericId = Number(id)
    if (Number.isNaN(numericId)) {
      throw ErrorFactories.invalidInput('id', id, 'Must be a valid number')
    }

    const updatedItem = await updateNavigationItem(numericId, updateData)
    
    log.info("Navigation item updated successfully", {
      itemId: updatedItem.id,
      label: updatedItem.label
    })
    
    timer({ status: "success", itemId: updatedItem.id })

    // Transform to SelectNavigationItem type
    const transformedUpdatedItem: SelectNavigationItem = {
      id: updatedItem.id,
      label: updatedItem.label,
      icon: updatedItem.icon,
      link: updatedItem.link ?? null,
      description: updatedItem.description ?? null,
      type: updatedItem.type,
      parentId: updatedItem.parentId ?? null,
      capabilityId: updatedItem.capabilityId ?? null,
      requiresRole: updatedItem.requiresRole ?? null,
      position: updatedItem.position,
      isActive: updatedItem.isActive,
      createdAt: updatedItem.createdAt,
      contentObjectId: updatedItem.contentObjectId ?? null
    }

    return createSuccess(transformedUpdatedItem, "Navigation item updated successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to update navigation item. Please try again or contact support.", {
      context: "updateNavigationItem",
      requestId,
      operation: "updateNavigationItem",
      metadata: { itemId: id }
    })
  }
}

export async function deleteNavigationItemAction(
  id: string | number
): Promise<ActionState<void>> {
  const requestId = generateRequestId()
  const timer = startTimer("deleteNavigationItem")
  const log = createLogger({ requestId, action: "deleteNavigationItem" })
  
  try {
    log.info("Action started: Deleting navigation item", { itemId: id })
    
    const session = await getServerSession()
    if (!session) {
      log.warn("Unauthorized navigation item deletion attempt")
      throw ErrorFactories.authNoSession()
    }

    // Admin-only: deleting a nav item breaks navigation for everyone
    // (REV-COR-039).
    if (!(await hasRole("administrator"))) {
      log.warn("Non-admin attempted to delete a navigation item", { userId: session.sub })
      throw ErrorFactories.authzInsufficientPermissions("administrator")
    }
    
    log.debug("User authenticated", { userId: session.sub })

    // Validate ID conversion
    const numericId = Number(id)
    if (Number.isNaN(numericId)) {
      throw ErrorFactories.invalidInput('id', id, 'Must be a valid number')
    }

    log.info("Deleting navigation item from database", { itemId: id })
    await deleteNavigationItem(numericId)
    
    log.info("Navigation item deleted successfully", { itemId: id })
    
    timer({ status: "success", itemId: id })
    
    return createSuccess(undefined, "Navigation item deleted successfully")
  } catch (error) {
    timer({ status: "error" })
    
    return handleError(error, "Failed to delete navigation item. Please try again or contact support.", {
      context: "deleteNavigationItem",
      requestId,
      operation: "deleteNavigationItem",
      metadata: { itemId: id }
    })
  }
}