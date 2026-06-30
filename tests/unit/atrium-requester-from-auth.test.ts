/**
 * Unit tests for requesterFromApiAuth + buildDelegatedRequester
 * (Issue #1055, Atrium Phase 5 §26 — agent identity resolution).
 *
 * Verifies the branch selection (delegated > autonomous > user) and the
 * grant-inheritance invariant: a delegated agent acting for an administrator is
 * NEVER itself admin, so it cannot exceed the human's grants.
 *
 * The DB is mocked: `executeQuery` dispatches by the call label so each path is
 * driven deterministically without a database.
 */

// executeQuery dispatches by label; tests set these rows.
let agentRows: Array<{
  id: string;
  name: string;
  roleId: number | null;
  roleName: string | null;
}> = [];
let userRows: Array<{
  building: string | null;
  department: string | null;
  gradeLevels: string[] | null;
}> = [];
let roleRows: Array<{ name: string }> = [];

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async (_fn: unknown, label: string) => {
    if (label === "atrium.requesterFromAuth.findAgent") return agentRows;
    if (label === "atrium.requesterFromAuth.loadUser") return userRows;
    if (label === "getUserRoles") return roleRows;
    return [];
  }),
}));

jest.mock("@/lib/db/schema", () => ({
  agentIdentities: {
    id: "id",
    name: "name",
    roleId: "roleId",
    oauthClientId: "oauthClientId",
    isActive: "isActive",
  },
  roles: { id: "id", name: "name" },
  users: { id: "id", building: "building", department: "department", gradeLevels: "gradeLevels" },
  userRoles: { userId: "userId", roleId: "roleId" },
}));

jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
}));

import {
  requesterFromApiAuth,
  buildDelegatedRequester,
} from "@/lib/content/requester-from-auth";
import { principalOf } from "@/lib/content/helpers";

beforeEach(() => {
  agentRows = [];
  userRows = [{ building: "High School", department: null, gradeLevels: null }];
  roleRows = [{ name: "staff" }];
  jest.clearAllMocks();
});

describe("requesterFromApiAuth", () => {
  it("builds an agent-delegated requester when delegated_for is present", async () => {
    const req = await requesterFromApiAuth({
      userId: 50,
      scopes: ["content:create", "content:update"],
      oauthClientId: "client-abc",
      delegatedForUserId: 7,
    });
    expect(req.kind).toBe("agent-delegated");
    if (req.kind !== "agent-delegated") throw new Error("wrong kind");
    expect(req.actingForUserId).toBe(7);
    expect(req.roles).toEqual(["staff"]);
    expect(req.building).toBe("High School");
    expect(req.scopes).toContain("content:create");
    expect(req.agentLabel).toBe("client-abc");
  });

  it("builds an agent-autonomous requester when the OIDC client maps to an identity", async () => {
    agentRows = [
      { id: "agent-1", name: "ship-reporter", roleId: 3, roleName: "staff" },
    ];
    const req = await requesterFromApiAuth({
      userId: 0,
      scopes: ["content:create", "content:publish_internal"],
      oauthClientId: "client-ship",
    });
    expect(req.kind).toBe("agent-autonomous");
    if (req.kind !== "agent-autonomous") throw new Error("wrong kind");
    expect(req.agentId).toBe("agent-1");
    expect(req.roleId).toBe(3);
    expect(req.roles).toEqual(["staff"]);
    expect(req.scopes).toContain("content:publish_internal");
    expect(req.agentLabel).toBe("ship-reporter");
  });

  it("falls back to a user requester for an sk- key / human OIDC token", async () => {
    roleRows = [{ name: "staff" }];
    const req = await requesterFromApiAuth({
      userId: 7,
      scopes: ["content:create"],
    });
    expect(req.kind).toBe("user");
    if (req.kind !== "user") throw new Error("wrong kind");
    expect(req.userId).toBe(7);
    expect(req.isAdmin).toBe(false);
  });

  it("marks a user requester admin when the user has the administrator role", async () => {
    roleRows = [{ name: "administrator" }];
    const req = await requesterFromApiAuth({ userId: 1, scopes: ["*"] });
    if (req.kind !== "user") throw new Error("wrong kind");
    expect(req.isAdmin).toBe(true);
  });

  it("throws when the referenced user does not exist (no silent guest)", async () => {
    userRows = [];
    await expect(
      requesterFromApiAuth({ userId: 999, scopes: [] })
    ).rejects.toThrow(/not found/);
  });
});

describe("buildDelegatedRequester grant-inheritance invariant", () => {
  it("never grants admin even when acting for an administrator", () => {
    const req = buildDelegatedRequester({
      actingForUserId: 1,
      roles: ["administrator"], // the human is an admin
      building: null,
      department: null,
      gradeLevels: null,
      scopes: ["content:create"],
      agentLabel: "delegate",
    });
    // principalOf forces isAdmin:false for delegated — the agent CANNOT exceed
    // the human's grants by inheriting admin power.
    expect(principalOf(req).isAdmin).toBe(false);
  });
});
