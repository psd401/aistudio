import { NextResponse } from "next/server"
import { getUsers, getUserRoles, createUser, updateUser, deleteUser } from "@/lib/db/data-api-adapter"
import { requireAdmin } from "@/lib/auth/admin-check"
import { createLogger, generateRequestId, startTimer } from "@/lib/logger"
export async function GET() {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.users.list");
  const log = createLogger({ requestId, route: "api.admin.users" });
  
  log.info("GET /api/admin/users - Fetching all users");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }
    
    // Get users from database via Data API
    const dbUsers = await getUsers();
    
    // Get all user roles
    const userRoles = await getUserRoles();
    
    // Group roles by userId
    const rolesByUser = userRoles.reduce((acc, role) => {
      const userId = Number(role.userId);
      if (!acc[userId]) {
        acc[userId] = [];
      }
      (acc[userId] as string[]).push(String(role.roleName));
      return acc;
    }, {} as Record<number, string[]>);

    // Map to the format expected by the UI
    const users = dbUsers.map((dbUser) => {
      const userRolesList = (rolesByUser[Number(dbUser.id)] as string[] | undefined) || []

      return {
        ...dbUser,
        role: (userRolesList as string[])[0] || "", // Legacy single role
        roles: userRolesList // Array of role names for multi-role support
      }
    })

    log.info("Users retrieved successfully", { count: users.length });
    timer({ status: "success", count: users.length });
    
    return NextResponse.json(
      {
        isSuccess: true,
        message: "Users retrieved successfully",
        data: users
      },
      { headers: { "X-Request-Id": requestId } }
    );
  } catch (error) {
    timer({ status: "error" });
    log.error("Error fetching users:", error);
    return NextResponse.json(
      { isSuccess: false, message: "Failed to fetch users" },
      { status: 500, headers: { "X-Request-Id": requestId } }
    );
  }
}

export async function POST(request: Request) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.users.create");
  const log = createLogger({ requestId, route: "api.admin.users" });
  
  log.info("POST /api/admin/users - Creating new user");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }
    
    const body = await request.json()
    
    log.debug("Creating user", { email: body.email });
    
    const userData = {
      cognitoSub: body.cognitoSub,
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email
    }

    const user = await createUser(userData)

    log.info("User created successfully", { userId: user.id });
    timer({ status: "success" });
    
    return NextResponse.json(
      {
        isSuccess: true,
        message: "User created successfully",
        data: user
      },
      { headers: { "X-Request-Id": requestId } }
    )
  } catch (error) {
    timer({ status: "error" });
    log.error("Error creating user:", error)
    return NextResponse.json(
      { isSuccess: false, message: "Failed to create user" },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}

export async function PUT(request: Request) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.users.update");
  const log = createLogger({ requestId, route: "api.admin.users" });
  
  log.info("PUT /api/admin/users - Updating user");
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    const body = await request.json()
    const { id, ...updates } = body
    
    log.debug("Updating user", { userId: id, updates });

    const user = await updateUser(Number.parseInt(String(id)), updates)

    log.info("User updated successfully", { userId: id });
    timer({ status: "success" });
    
    return NextResponse.json(
      {
        isSuccess: true,
        message: "User updated successfully",
        data: user
      },
      { headers: { "X-Request-Id": requestId } }
    )
  } catch (error) {
    timer({ status: "error" });
    log.error("Error updating user:", error)
    return NextResponse.json(
      { isSuccess: false, message: "Failed to update user" },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
}

export async function DELETE(request: Request) {
  const requestId = generateRequestId();
  const timer = startTimer("api.admin.users.delete");
  const log = createLogger({ requestId, route: "api.admin.users" });
  
  const { searchParams } = new URL(request.url)
  const id = searchParams.get("id")
  
  log.info("DELETE /api/admin/users - Deleting user", { userId: id });
  
  try {
    // Check admin authorization
    const authError = await requireAdmin();
    if (authError) {
      log.warn("Unauthorized admin access attempt");
      timer({ status: "error", reason: "unauthorized" });
      return authError;
    }

    if (!id) {
      log.warn("Missing user ID in delete request");
      timer({ status: "error", reason: "missing_id" });
      return NextResponse.json(
        { isSuccess: false, message: "Missing user ID" },
        { status: 400, headers: { "X-Request-Id": requestId } }
      )
    }

    const user = await deleteUser(Number.parseInt(String(id)))

    log.info("User deleted successfully", { userId: id });
    timer({ status: "success" });
    
    return NextResponse.json(
      {
        isSuccess: true,
        message: "User deleted successfully",
        data: user
      },
      { headers: { "X-Request-Id": requestId } }
    )
  } catch (error) {
    timer({ status: "error" });
    log.error("Error deleting user:", error)
    return NextResponse.json(
      { isSuccess: false, message: "Failed to delete user" },
      { status: 500, headers: { "X-Request-Id": requestId } }
    )
  }
} 