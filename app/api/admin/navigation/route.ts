import { NextResponse } from "next/server"
import { requireAdmin } from "@/lib/auth/admin-check"
import { getNavigationItems, createNavigationItem, updateNavigationItem } from "@/lib/db/data-api-adapter"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"

export async function GET() {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.navigation.list");
  const log = createLogger({ requestId, route: "api.admin.navigation" });
  
  log.info("GET /api/admin/navigation - Fetching navigation items");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    // Get all navigation items (not just active ones for admin)
    const navItems = await getNavigationItems(false)
    
    // Items are already in camelCase from the data adapter
    const transformedItems = navItems

    log.info("Navigation items retrieved successfully", { count: transformedItems.length });
    timer({ status: "success", count: transformedItems.length });
    
    return NextResponse.json(
      {
        isSuccess: true,
        data: transformedItems
      },
      { headers: { "X-Request-Id": requestId } }
    )
  } catch (error) {
    timer({ status: "error" });
    log.error("Error fetching navigation items", error);
    return NextResponse.json(
      { 
        isSuccess: false, 
        message: error instanceof Error ? error.message : "Failed to fetch navigation items"
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.navigation.create");
  const log = createLogger({ requestId, route: "api.admin.navigation" });
  
  log.info("POST /api/admin/navigation - Creating or updating navigation item");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    const body = await request.json()
    
    log.debug("Navigation item operation", { 
      label: body.label, 
      type: body.type,
      hasId: !!body.id 
    });

    // Validate required fields
    if (!body.label || !body.icon || !body.type) {
      log.warn("Missing required fields for navigation item");
      timer({ status: "error", reason: "validation_error" });
      return NextResponse.json(
        { isSuccess: false, message: "Missing required fields" },
        { status: 400, headers: { "X-Request-Id": requestId } }
      )
    }

    // Check if this is an update operation by checking if the item exists
    if (body.id) {
      // First check if this ID exists in the database
      const existingItems = await getNavigationItems();
      const itemExists = existingItems.some(item => item.id === Number(body.id));
      
      if (itemExists) {
        // This is an update operation
        const { id, ...data } = body;
        try {
          const updatedItem = await updateNavigationItem(Number(id), data)

          log.info("Navigation item updated successfully", { itemId: id });
          timer({ status: "success", action: "update" });
          
          return NextResponse.json(
            {
              isSuccess: true,
              message: "Navigation item updated successfully",
              data: updatedItem
            },
            { headers: { "X-Request-Id": requestId } }
          )
        } catch (error) {
          timer({ status: "error" });
          log.error("Error updating navigation item", error);
          const errorMessage = error instanceof Error ? error.message : "Failed to update navigation item";
          return NextResponse.json(
            { isSuccess: false, message: errorMessage },
            { status: 500, headers: { "X-Request-Id": requestId } }
          )
        }
      }
      // If the item doesn't exist, fall through to create it
    }
    
    // Create new item (ID will be auto-generated)
    try {
      const newItem = await createNavigationItem({
        label: body.label,
        icon: body.icon,
        link: body.link,
        description: body.description,
        type: body.type,
        parentId: body.parentId ? Number(body.parentId) : undefined,
        toolId: body.toolId ? Number(body.toolId) : undefined,
        requiresRole: body.requiresRole,
        position: body.position || 0,
        isActive: body.isActive ?? true
      })

      log.info("Navigation item created successfully", { itemId: newItem.id });
      timer({ status: "success", action: "create" });
      
      return NextResponse.json(
        {
          isSuccess: true,
          message: "Navigation item created successfully",
          data: newItem
        },
        { headers: { "X-Request-Id": requestId } }
      )
    } catch (error) {
      timer({ status: "error" });
      log.error("Error creating navigation item", error);
      const errorMessage = error instanceof Error ? error.message : "Failed to create navigation item";
      return NextResponse.json(
        { isSuccess: false, message: errorMessage },
        { status: 500, headers: { "X-Request-Id": requestId } }
      )
    }
  } catch (error) {
    timer({ status: "error" });
    log.error("Error handling navigation item request", error);
    return NextResponse.json(
      { 
        isSuccess: false, 
        message: error instanceof Error ? error.message : "Failed to handle navigation item request"
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}

export async function PATCH(request: Request) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.navigation.patch");
  const log = createLogger({ requestId, route: "api.admin.navigation" });
  
  log.info("PATCH /api/admin/navigation - Updating navigation position");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    const body = await request.json()
    
    log.debug("Updating navigation position", { id: body.id, position: body.position });
    
    if (!body.id || typeof body.position !== 'number') {
      log.warn("Missing id or position in PATCH request");
      timer({ status: "error", reason: "validation_error" });
      return NextResponse.json(
        { isSuccess: false, message: "Missing id or position" },
        { status: 400, headers: { "X-Request-Id": requestId } }
      )
    }

    const updatedItem = await updateNavigationItem(Number(body.id), { position: body.position })


    if (!updatedItem) {
      log.warn("Navigation item not found", { itemId: body.id });
      timer({ status: "error", reason: "not_found" });
      return NextResponse.json(
        { isSuccess: false, message: "Item not found" },
        { status: 404, headers: { "X-Request-Id": requestId } }
      )
    }

    log.info("Position updated successfully", { itemId: body.id });
    timer({ status: "success" });

    return NextResponse.json(
      {
        isSuccess: true,
        message: "Position updated successfully",
        data: updatedItem
      },
      { headers: { "X-Request-Id": requestId } }
    )
  } catch (error) {
    timer({ status: "error" });
    log.error("Error updating position", error);
    return NextResponse.json(
      { 
        isSuccess: false, 
        message: error instanceof Error ? error.message : "Failed to update position"
      },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
} 