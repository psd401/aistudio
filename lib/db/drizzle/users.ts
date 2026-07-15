/**
 * Drizzle User Operations
 *
 * User CRUD operations migrated from RDS Data API to Drizzle ORM.
 * All functions use executeQuery() wrapper with circuit breaker and retry logic.
 *
 * Part of Epic #526 - RDS Data API to Drizzle ORM Migration
 * Issue #531 - Migrate User & Authorization queries to Drizzle ORM
 *
 * @see https://orm.drizzle.team/docs/select
 */

import { eq, and, desc, sql } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  users,
  userRoles,
  roles,
} from "@/lib/db/schema";
import { ErrorFactories } from "@/lib/error-utils";

// ============================================
// Types
// ============================================

export interface UserData {
  id?: number;
  cognitoSub: string;
  email: string;
  firstName?: string;
  lastName?: string;
}

// ============================================
// User Query Operations
// ============================================

/**
 * Get all users ordered by creation date (newest first)
 */
export async function getUsers() {
  return executeQuery(
    (db) =>
      db
        .select({
          id: users.id,
          cognitoSub: users.cognitoSub,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          lastSignInAt: users.lastSignInAt,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .orderBy(desc(users.createdAt)),
    "getUsers"
  );
}

/**
 * Get user by database ID
 * @throws {DatabaseError} If user not found
 */
export async function getUserById(userId: number) {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          id: users.id,
          cognitoSub: users.cognitoSub,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          lastSignInAt: users.lastSignInAt,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1),
    "getUserById"
  );

  if (!result[0]) {
    throw ErrorFactories.dbRecordNotFound("users", userId);
  }

  return result[0];
}

/**
 * Get user by email address.
 *
 * Case-INSENSITIVE (`lower(email) = lower(:email)`) — email is an authorization join
 * key and migration 112 (#1207) enforces uniqueness on `lower(email)`. A
 * case-sensitive `=` here would miss an existing row when Cognito sends a
 * differently-cased address, and the caller's fall-through insert/link would then
 * violate `uq_users_email_lower` and lock the user out of provisioning. Lowercasing
 * both sides also lets the query use that functional unique index.
 *
 * @throws {DatabaseError} If user not found
 */
export async function getUserByEmail(email: string) {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          id: users.id,
          cognitoSub: users.cognitoSub,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          lastSignInAt: users.lastSignInAt,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .where(eq(sql`lower(${users.email})`, email.toLowerCase()))
        .limit(1),
    "getUserByEmail"
  );

  if (!result[0]) {
    throw ErrorFactories.dbRecordNotFound("users", email);
  }

  return result[0];
}

/**
 * Get user by Cognito sub (unique identifier from AWS Cognito)
 *
 * @returns User object or undefined if not found
 *
 * Note: Returns undefined (not throws) for "not found" case.
 * This is intentional for authentication flows where users may not exist yet
 * (e.g., first-time login, registration). Use getUserById() if you expect
 * the user to exist and want to throw on not found.
 */
export async function getUserByCognitoSub(cognitoSub: string) {
  const result = await executeQuery(
    (db) =>
      db
        .select({
          id: users.id,
          cognitoSub: users.cognitoSub,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          lastSignInAt: users.lastSignInAt,
          roleVersion: users.roleVersion,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .where(eq(users.cognitoSub, cognitoSub))
        .limit(1),
    "getUserByCognitoSub"
  );
  return result[0];
}

/**
 * Get user ID by Cognito sub
 *
 * @returns String representation of user ID or null if not found
 *
 * Note: Returns string (not number) for backward compatibility with existing
 * RDS Data API implementation. Many consumers expect string type for this function.
 * If you need numeric ID, use getUserByCognitoSub(sub)?.id instead.
 */
export async function getUserIdByCognitoSub(
  cognitoSub: string
): Promise<string | null> {
  const result = await executeQuery(
    (db) =>
      db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.cognitoSub, cognitoSub))
        .limit(1),
    "getUserIdByCognitoSub"
  );
  return result[0]?.id ? String(result[0].id) : null;
}

// ============================================
// User CRUD Operations
// ============================================

/**
 * Create or update user (upsert on cognito_sub conflict)
 *
 * @param userData - User data to insert or update
 * @returns Created or updated user record
 *
 * **Upsert Behavior:**
 * - On INSERT: Creates new user with all provided fields
 * - On CONFLICT (cognito_sub exists):
 *   - email: Always updated to new value
 *   - firstName/lastName: **Preserves existing values if new values are null**
 *   - This prevents OAuth providers that don't return names from clearing existing data
 *
 * **Example:**
 * ```typescript
 * // User exists with firstName="John", lastName="Doe"
 * await createUser({ cognitoSub: "sub123", email: "john@example.com", firstName: null, lastName: null })
 * // Result: firstName="John", lastName="Doe" (preserved)
 * ```
 */
export async function createUser(userData: UserData) {
  const result = await executeQuery(
    (db) =>
      db
        .insert(users)
        .values({
          cognitoSub: userData.cognitoSub,
          email: userData.email,
          firstName: userData.firstName,
          lastName: userData.lastName,
        })
        .onConflictDoUpdate({
          target: users.cognitoSub,
          set: {
            email: userData.email,
            firstName: sql`COALESCE(${userData.firstName}, ${users.firstName})`,
            lastName: sql`COALESCE(${userData.lastName}, ${users.lastName})`,
            updatedAt: new Date(),
          },
        })
        .returning({
          id: users.id,
          cognitoSub: users.cognitoSub,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        }),
    "createUser"
  );
  return result[0];
}

/**
 * Update user by database ID
 */
export async function updateUser(
  id: number,
  updates: Partial<{
    cognitoSub: string;
    email: string;
    firstName: string;
    lastName: string;
    lastSignInAt: Date;
  }>
) {
  const result = await executeQuery(
    (db) =>
      db
        .update(users)
        .set({
          ...updates,
          updatedAt: new Date(),
        })
        .where(eq(users.id, id))
        .returning(),
    "updateUser"
  );
  return result[0];
}

/**
 * Delete user by database ID
 *
 * **Hard Delete Behavior:**
 * - Performs permanent deletion from database (NOT a soft delete)
 * - Cascading deletes remove related records (user_roles, etc.) via foreign key constraints
 * - This is intentional for GDPR compliance and data deletion requirements
 * - Use with caution - this operation cannot be undone
 * - For temporary deactivation, consider adding an `isActive` flag instead
 *
 * @param id - The user database ID
 * @returns The deleted user record
 */
export async function deleteUser(id: number) {
  const result = await executeQuery(
    (db) => db.delete(users).where(eq(users.id, id)).returning(),
    "deleteUser"
  );
  return result[0];
}

// ============================================
// User Role Check Operations
// ============================================

/**
 * Check if user has a specific role by user ID
 */
export async function checkUserRole(
  userId: number,
  roleName: string
): Promise<boolean> {
  const result = await executeQuery(
    (db) =>
      db
        .select({ userId: userRoles.userId })
        .from(userRoles)
        .innerJoin(roles, eq(userRoles.roleId, roles.id))
        .where(and(eq(userRoles.userId, userId), eq(roles.name, roleName)))
        .limit(1),
    "checkUserRole"
  );
  return result.length > 0;
}

/**
 * Check if user has a specific role by Cognito sub
 */
export async function checkUserRoleByCognitoSub(
  cognitoSub: string,
  roleName: string
): Promise<boolean> {
  const result = await executeQuery(
    (db) =>
      db
        .select({ userId: users.id })
        .from(users)
        .innerJoin(userRoles, eq(users.id, userRoles.userId))
        .innerJoin(roles, eq(userRoles.roleId, roles.id))
        .where(and(eq(users.cognitoSub, cognitoSub), eq(roles.name, roleName)))
        .limit(1),
    "checkUserRoleByCognitoSub"
  );
  return result.length > 0;
}

/**
 * Get all role names for a user by Cognito sub
 */
export async function getUserRolesByCognitoSub(
  cognitoSub: string
): Promise<string[]> {
  const result = await executeQuery(
    (db) =>
      db
        .select({ name: roles.name })
        .from(users)
        .innerJoin(userRoles, eq(users.id, userRoles.userId))
        .innerJoin(roles, eq(userRoles.roleId, roles.id))
        .where(eq(users.cognitoSub, cognitoSub))
        .orderBy(roles.name),
    "getUserRolesByCognitoSub"
  );
  return result.map((r) => r.name);
}

/**
 * Get all user-role mappings
 * Returns array of { userId, roleName } for building user role maps
 */
export async function getAllUserRoles() {
  return executeQuery(
    (db) =>
      db
        .select({
          userId: userRoles.userId,
          roleName: roles.name,
        })
        .from(userRoles)
        .innerJoin(roles, eq(userRoles.roleId, roles.id))
        .orderBy(roles.name),
    "getAllUserRoles"
  );
}

// Capability access checks live in `lib/db/drizzle/capabilities.ts`
// (`hasCapabilityAccess`, `getUserCapabilities`). The legacy `hasToolAccess` /
// `getUserTools` compat shims were removed in workstream #6 (Issue #928).
