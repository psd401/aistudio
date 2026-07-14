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
// The by-id lookup carries the identity's OWN scopes (a scheduled run has no token).
let agentByIdRows: Array<{
  id: string;
  name: string;
  roleId: number | null;
  roleName: string | null;
  scopes: string[];
}> = [];
let userRows: Array<{
  building: string | null;
  department: string | null;
  gradeLevels: string[] | null;
}> = [];
let roleRows: Array<{ name: string }> = [];
// The synced group memberships loadUserContext resolves for #1205 (rows shaped as
// listUserGroupEmailsByUserId's `{ groupEmail }` projection).
let groupRows: Array<{ groupEmail: string }> = [];

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async (_fn: unknown, label: string) => {
    if (label === "atrium.requesterFromAuth.findAgent") return agentRows;
    if (label === "atrium.requesterFromAuth.findAgentById") return agentByIdRows;
    if (label === "atrium.requesterFromAuth.loadUser") return userRows;
    if (label === "getUserRoles") return roleRows;
    if (label === "listUserGroupEmailsByUserId") return groupRows;
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
    scopes: "scopes",
  },
  roles: { id: "id", name: "name" },
  users: {
    id: "id",
    email: "email",
    building: "building",
    department: "department",
    gradeLevels: "gradeLevels",
  },
  userRoles: { userId: "userId", roleId: "roleId" },
  // lib/groups/queries (imported by requester-from-auth for
  // listUserGroupEmailsByUserId) builds a module-level select object from these,
  // so they must be defined objects even though the query callbacks never run here.
  groups: { id: "id", groupEmail: "groupEmail", name: "name", isActive: "isActive" },
  groupMembers: { groupId: "groupId", memberEmail: "memberEmail" },
  groupSelectionRules: {},
  groupRoleMappings: {
    id: "id",
    groupEmail: "groupEmail",
    roleId: "roleId",
    createdAt: "createdAt",
  },
}));

jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
}));

import {
  requesterFromApiAuth,
  buildDelegatedRequester,
  buildAutonomousRequesterForIdentity,
  requesterForUserId,
} from "@/lib/content/requester-from-auth";
import { principalOf } from "@/lib/content/helpers";
import { buildDelegatedTokenClaims } from "@/lib/oauth/delegated-token";

// The autonomous-vs-human discriminator keys off ATRIUM_SYSTEM_USER_ID: a
// client-credentials (machine) token's sub === this id; a human's is their own.
// Pin it to 3 so the "deactivated machine token" test (userId 3) fails closed
// while a human token (any other userId) resolves as a user.
const ORIGINAL_SYSTEM_USER_ID = process.env.ATRIUM_SYSTEM_USER_ID;
beforeAll(() => {
  process.env.ATRIUM_SYSTEM_USER_ID = "3";
});
afterAll(() => {
  if (ORIGINAL_SYSTEM_USER_ID === undefined) delete process.env.ATRIUM_SYSTEM_USER_ID;
  else process.env.ATRIUM_SYSTEM_USER_ID = ORIGINAL_SYSTEM_USER_ID;
});

beforeEach(() => {
  agentRows = [];
  agentByIdRows = [];
  userRows = [{ building: "High School", department: null, gradeLevels: null }];
  roleRows = [{ name: "staff" }];
  groupRows = [];
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

  it("populates a user requester's group memberships from loadUserContext (#1205)", async () => {
    groupRows = [
      { groupEmail: "hs-staff@psd401.net" },
      { groupEmail: "all-staff@psd401.net" },
    ];
    const req = await requesterFromApiAuth({ userId: 7, scopes: ["content:read"] });
    if (req.kind !== "user") throw new Error("wrong kind");
    expect(req.groups).toEqual([
      "hs-staff@psd401.net",
      "all-staff@psd401.net",
    ]);
    // principalOf surfaces the same set as the canView/list match set.
    expect(principalOf(req).groups).toEqual([
      "hs-staff@psd401.net",
      "all-staff@psd401.net",
    ]);
  });

  it("a delegated agent INHERITS the human's group memberships (#1205)", async () => {
    groupRows = [{ groupEmail: "hs-staff@psd401.net" }];
    const req = await requesterFromApiAuth({
      userId: 50,
      scopes: ["content:read"],
      oauthClientId: "client-abc",
      delegatedForUserId: 7,
    });
    if (req.kind !== "agent-delegated") throw new Error("wrong kind");
    expect(req.groups).toEqual(["hs-staff@psd401.net"]);
    expect(principalOf(req).groups).toEqual(["hs-staff@psd401.net"]);
  });

  it("an autonomous agent has NO group memberships (#1205)", async () => {
    agentRows = [
      { id: "agent-1", name: "ship-reporter", roleId: 3, roleName: "staff" },
    ];
    const req = await requesterFromApiAuth({
      userId: 0,
      scopes: ["content:create"],
      oauthClientId: "client-ship",
    });
    if (req.kind !== "agent-autonomous") throw new Error("wrong kind");
    // Autonomous agents have no human identity → principalOf yields an empty set.
    expect(principalOf(req).groups).toEqual([]);
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

  it("falls back to autonomous resolution when delegated_for is stale but oauthClientId matches an active agent", async () => {
    userRows = []; // the delegated_for user id does not resolve
    agentRows = [
      { id: "agent-2", name: "stale-delegate-fallback", roleId: 4, roleName: "staff" },
    ];
    const req = await requesterFromApiAuth({
      userId: 0,
      scopes: ["content:create"],
      oauthClientId: "client-ship",
      delegatedForUserId: 999,
    });
    expect(req.kind).toBe("agent-autonomous");
    if (req.kind !== "agent-autonomous") throw new Error("wrong kind");
    expect(req.agentId).toBe("agent-2");
  });

  it("throws when delegated_for is stale and there is no oauthClientId to fall back to", async () => {
    userRows = [];
    await expect(
      requesterFromApiAuth({
        userId: 0,
        scopes: ["content:create"],
        delegatedForUserId: 999,
      })
    ).rejects.toThrow(/Delegated-for user not found/);
  });

  it("fails closed for a MACHINE token (sub === system user) whose agent identity is inactive", async () => {
    // A client-credentials token's oauthClientId with no matching ACTIVE
    // agent_identities row (deactivated, or never registered) must be rejected
    // outright — falling through to `userId` (=== ATRIUM_SYSTEM_USER_ID here)
    // would silently re-resolve it as the system account, undoing a deliberate
    // revocation. userId 3 === the pinned ATRIUM_SYSTEM_USER_ID.
    agentRows = [];
    await expect(
      requesterFromApiAuth({
        userId: 3,
        scopes: ["content:update"],
        oauthClientId: "client-deactivated",
      })
    ).rejects.toThrow(/No active agent identity/);
  });

  it("resolves a HUMAN OIDC token (sub !== system user) as a user even though it carries an oauthClientId", async () => {
    // verifyJwtToken populates oauthClientId from client_id/azp for EVERY JWT, so
    // a human authorization-code/PKCE login carries one whose client is NOT a
    // registered agent. Its sub is the human's own id (42, not the system user 3),
    // so it must resolve as that `user` — not be denied with a spurious 403.
    agentRows = []; // the human's OAuth client is not a registered agent
    userRows = [{ building: "Middle School", department: null, gradeLevels: null }];
    roleRows = [{ name: "staff" }];
    const req = await requesterFromApiAuth({
      userId: 42,
      scopes: ["content:create"],
      oauthClientId: "client-human-pkce-app",
    });
    expect(req.kind).toBe("user");
    if (req.kind !== "user") throw new Error("wrong kind");
    expect(req.userId).toBe(42);
    expect(req.isAdmin).toBe(false);
  });
});

describe("buildAutonomousRequesterForIdentity (scheduled-run identity path)", () => {
  it("builds an agent-autonomous requester from an active identity id, scopes from the row", async () => {
    // A scheduled run carries no token, so the identity's authority is its OWN
    // scopes column — not an OAuth token's scopes.
    agentByIdRows = [
      {
        id: "agent-9",
        name: "ship-reporter",
        roleId: 5,
        roleName: "staff",
        scopes: ["content:create", "content:publish_internal"],
      },
    ];
    const req = await buildAutonomousRequesterForIdentity("agent-9");
    expect(req.kind).toBe("agent-autonomous");
    if (req.kind !== "agent-autonomous") throw new Error("wrong kind");
    expect(req.agentId).toBe("agent-9");
    expect(req.roleId).toBe(5);
    expect(req.roles).toEqual(["staff"]);
    // Scopes come from the identity row, NOT a token.
    expect(req.scopes).toEqual(["content:create", "content:publish_internal"]);
    // The identity never carries content:publish_public (public-publish is human-held).
    expect(req.scopes).not.toContain("content:publish_public");
    expect(req.agentLabel).toBe("ship-reporter");
  });

  it("fails closed (throws) when the identity id is missing or inactive", async () => {
    // No matching ACTIVE row (deactivated or unknown id) → throw, so a scheduled run
    // aborts rather than silently running as the owning user with human authority.
    agentByIdRows = [];
    await expect(
      buildAutonomousRequesterForIdentity("deactivated-agent")
    ).rejects.toThrow(/No active agent identity/);
  });

  it("yields an empty roles array when the identity has no role", async () => {
    agentByIdRows = [
      { id: "agent-x", name: "role-less", roleId: null, roleName: null, scopes: ["content:create"] },
    ];
    const req = await buildAutonomousRequesterForIdentity("agent-x");
    if (req.kind !== "agent-autonomous") throw new Error("wrong kind");
    expect(req.roles).toEqual([]);
    expect(req.roleId).toBeNull();
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

describe("requesterForUserId (API-key execution path, #1059 completion)", () => {
  it("builds a plain user requester with admin derived from roles", async () => {
    roleRows = [{ name: "administrator" }];
    const req = await requesterForUserId(42);
    expect(req).not.toBeNull();
    if (!req || req.kind !== "user") throw new Error("wrong kind");
    expect(req.userId).toBe(42);
    expect(req.roles).toEqual(["administrator"]);
    expect(req.building).toBe("High School");
    expect(req.isAdmin).toBe(true);
  });

  it("returns null (never throws) when the user row is missing", async () => {
    userRows = [];
    await expect(requesterForUserId(999)).resolves.toBeNull();
  });

  it("returns null (never throws) when the lookup itself fails", async () => {
    const { executeQuery } = jest.requireMock("@/lib/db/drizzle-client") as {
      executeQuery: jest.Mock;
    };
    executeQuery.mockRejectedValueOnce(new Error("db down"));
    await expect(requesterForUserId(42)).resolves.toBeNull();
  });
});

describe("delegated token mint→consume round-trip (§26.1, #1059)", () => {
  it("a token minted for an ADMIN resolves to agent-delegated and is NEVER admin", async () => {
    // The acting-for user is an administrator.
    roleRows = [{ name: "administrator" }];
    // Mint claims exactly as the route does.
    const claims = buildDelegatedTokenClaims({
      systemUserId: "3", // the pinned system user (sub)
      delegatedForUserId: 42,
      agentClientId: "agent-client-1",
      scopes: ["content:create", "content:read"],
      issuer: "https://issuer.example",
      nowSeconds: 1_000_000,
      jti: "jti-1",
    });
    // Extract exactly what auth-middleware derives from a verified JWT.
    const delegatedForUserId = Number.isInteger(Number(claims.delegated_for))
      ? Number(claims.delegated_for)
      : undefined;
    const req = await requesterFromApiAuth({
      userId: Number(claims.sub), // 3 = system user
      scopes: (claims.scope as string).split(" "),
      oauthClientId: claims.client_id as string,
      delegatedForUserId,
    });
    expect(req.kind).toBe("agent-delegated");
    if (req.kind !== "agent-delegated") throw new Error("wrong kind");
    expect(req.actingForUserId).toBe(42);
    expect(req.scopes).toEqual(["content:create", "content:read"]);
    // THE security invariant: acting for an admin does NOT make the agent admin.
    expect(principalOf(req).isAdmin).toBe(false);
  });

  it("act.sub (agent client id) is non-numeric, so it never leaks in as delegated_for", () => {
    const claims = buildDelegatedTokenClaims({
      systemUserId: "3",
      delegatedForUserId: 42,
      agentClientId: "agent-client-1",
      scopes: ["content:read"],
      issuer: "https://issuer.example",
      nowSeconds: 1_000_000,
      jti: "jti-2",
    });
    // auth-middleware's fallback: delegated_for ?? act.sub, coerced to int.
    const actSub = (claims.act as { sub: string }).sub;
    expect(Number.isInteger(Number(actSub))).toBe(false);
  });
});
