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
      toolId: item.toolId ?? null,
      requiresRole: item.requiresRole ?? null,
      position: item.position,
      isActive: item.isActive,
      createdAt: item.createdAt
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
    
    log.debug("User authenticated", { userId: session.sub })
    
    log.info("Creating navigation item in database", {
      label: data.label,
      type: data.type,
      isActive: data.isActive ?? true
    })
    
    // Validate numeric conversions
    let parentId: number | undefined
    if (data.parentId !== undefined && data.parentId !== null) {
      const numParentId = Number(data.parentId)
      if (Number.isNaN(numParentId)) {
        throw ErrorFactories.invalidInput('parentId', data.parentId, 'Must be a valid number')
      }
      parentId = numParentId
    }

    let toolId: number | undefined
    if (data.toolId !== undefined && data.toolId !== null) {
      const numToolId = Number(data.toolId)
      if (Number.isNaN(numToolId)) {
        throw ErrorFactories.invalidInput('toolId', data.toolId, 'Must be a valid number')
      }
      toolId = numToolId
    }

    const newItem = await createNavigationItem({
      label: data.label,
      icon: data.icon,
      link: data.link ?? undefined,
      description: data.description ?? undefined,
      type: data.type || 'page',
      parentId,
      toolId,
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
      toolId: newItem.toolId ?? null,
      requiresRole: newItem.requiresRole ?? null,
      position: newItem.position,
      isActive: newItem.isActive,
      createdAt: newItem.createdAt
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
    
    log.debug("User authenticated", { userId: session.sub })
    // Convert null values to undefined for updateNavigationItem
    const updateData: Partial<{
      label: string;
      icon: string;
      link: string;
      description: string;
      type: "link" | "section" | "page";
      parentId: number;
      toolId: number;
      requiresRole: string;
      position: number;
      isActive: boolean;
    }> = {}
    
    if (data.label !== undefined) updateData.label = data.label
    if (data.icon !== undefined) updateData.icon = data.icon
    if (data.link !== undefined && data.link !== null) updateData.link = data.link
    if (data.description !== undefined && data.description !== null) updateData.description = data.description
    if (data.type !== undefined && (data.type === "link" || data.type === "section" || data.type === "page")) updateData.type = data.type
    if (data.parentId !== undefined && data.parentId !== null) updateData.parentId = data.parentId
    if (data.toolId !== undefined && data.toolId !== null) updateData.toolId = data.toolId
    if (data.requiresRole !== undefined && data.requiresRole !== null) updateData.requiresRole = data.requiresRole
    if (data.position !== undefined) updateData.position = data.position
    if (data.isActive !== undefined) updateData.isActive = data.isActive
    
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
      toolId: updatedItem.toolId ?? null,
      requiresRole: updatedItem.requiresRole ?? null,
      position: updatedItem.position,
      isActive: updatedItem.isActive,
      createdAt: updatedItem.createdAt
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