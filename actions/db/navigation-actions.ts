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
    
    return createSuccess(items as unknown as SelectNavigationItem[], "Navigation items retrieved successfully")
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
    
    const newItem = await createNavigationItem({
      label: data.label,
      icon: data.icon,
      link: data.link ?? undefined,
      description: data.description ?? undefined,
      type: data.type || 'page',
      parentId: data.parentId ? Number(data.parentId) : undefined,
      toolId: data.toolId ? Number(data.toolId) : undefined,
      requiresRole: data.requiresRole ?? undefined,
      position: data.position,
      isActive: data.isActive ?? true
    })
    
    log.info("Navigation item created successfully", {
      itemId: newItem.id,
      label: newItem.label
    })
    
    timer({ status: "success", itemId: newItem.id })
    
    return createSuccess(newItem as unknown as SelectNavigationItem, "Navigation item created successfully")
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
    
    const updatedItem = await updateNavigationItem(Number(id), updateData)
    
    log.info("Navigation item updated successfully", {
      itemId: updatedItem.id,
      label: updatedItem.label
    })
    
    timer({ status: "success", itemId: updatedItem.id })
    
    return createSuccess(updatedItem as unknown as SelectNavigationItem, "Navigation item updated successfully")
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
    
    log.info("Deleting navigation item from database", { itemId: id })
    await deleteNavigationItem(Number(id))
    
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