/**
 * Pure-predicate tests for the hard-delete authorization gate (Atrium hard delete).
 *
 * `canDelete` is deliberately its OWN predicate (not `canEdit`): strictly
 * owner-or-admin, and keyed off the `content:delete` scope for agent callers.
 * These tests pin that contract so a future widening of `canEdit` can never
 * silently hand out delete, and so the delete scope (not update) gates agents.
 */

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(),
}));
jest.mock("@/lib/db/schema", () => ({}));
jest.mock("@/lib/content/events", () => ({
  contentEvents: { emit: jest.fn(async () => undefined) },
}));

import { canDelete, assertCanDelete } from "@/lib/content/helpers";
import { ForbiddenError } from "@/lib/content/errors";
import type { Requester } from "@/lib/content/types";

const OWNER_ID = 7;
const SYSTEM_USER_ID = 999;

const userOwner: Requester = { kind: "user", userId: OWNER_ID, roles: ["staff"], isAdmin: false };
const userOther: Requester = { kind: "user", userId: 8, roles: ["staff"], isAdmin: false };
const userAdmin: Requester = { kind: "user", userId: 42, roles: ["administrator"], isAdmin: true };

function delegated(scopes: string[], actingForUserId = OWNER_ID): Requester {
  return {
    kind: "agent-delegated",
    actingForUserId,
    agentLabel: "delegated",
    scopes,
    roles: ["staff"],
    building: null,
    department: null,
    gradeLevels: null,
  };
}

function autonomous(scopes: string[]): Requester {
  return {
    kind: "agent-autonomous",
    agentId: "agent-2",
    agentLabel: "autonomous",
    scopes,
    roles: ["staff"],
  };
}

describe("canDelete — owner-or-admin, delete-scoped for agents", () => {
  const saved = process.env.ATRIUM_SYSTEM_USER_ID;
  beforeAll(() => {
    process.env.ATRIUM_SYSTEM_USER_ID = String(SYSTEM_USER_ID);
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.ATRIUM_SYSTEM_USER_ID;
    else process.env.ATRIUM_SYSTEM_USER_ID = saved;
  });

  it("owner (user) may delete their own object", () => {
    expect(canDelete(userOwner, OWNER_ID)).toBe(true);
  });

  it("a non-owner user may NOT delete", () => {
    expect(canDelete(userOther, OWNER_ID)).toBe(false);
  });

  it("an admin may delete anyone's object", () => {
    expect(canDelete(userAdmin, OWNER_ID)).toBe(true);
  });

  it("a delegated agent acting for the owner needs the content:delete scope", () => {
    expect(canDelete(delegated(["content:delete"]), OWNER_ID)).toBe(true);
    // Holding UPDATE but not DELETE must NOT grant delete (scope keyed correctly).
    expect(canDelete(delegated(["content:update"]), OWNER_ID)).toBe(false);
    // Acting for a DIFFERENT user than the owner is never allowed.
    expect(canDelete(delegated(["content:delete"], 8), OWNER_ID)).toBe(false);
  });

  it("an autonomous agent may delete only the system-user's content, with the delete scope", () => {
    expect(canDelete(autonomous(["content:delete"]), SYSTEM_USER_ID)).toBe(true);
    // Not the system user's content.
    expect(canDelete(autonomous(["content:delete"]), OWNER_ID)).toBe(false);
    // Missing the delete scope.
    expect(canDelete(autonomous(["content:update"]), SYSTEM_USER_ID)).toBe(false);
  });

  it("assertCanDelete throws ForbiddenError for a non-owner", () => {
    expect(() => assertCanDelete(userOther, OWNER_ID)).toThrow(ForbiddenError);
    expect(() => assertCanDelete(userOwner, OWNER_ID)).not.toThrow();
  });
});
