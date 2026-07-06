/**
 * POST /api/v1/agents/delegated-token — route guard + minting tests (§26.1, #1059).
 *
 * Drives the real handler (withApiAuth unwrapped) with controlled auth contexts and
 * a label-dispatched executeQuery mock. Asserts the authorization guards reject
 * non-agent / already-delegated / unknown-user callers, and that a valid request
 * signs claims bounded to the agent ∩ user content-scope intersection (never admin,
 * never the authority scope, never publish_public for a staff user).
 */

const createErrorResponseMock = jest.fn(
  (_rid: string, status: number, code: string) => ({ status, code })
);
const createApiResponseMock = jest.fn((data: unknown) => ({ ok: true, data }));

jest.mock("@/lib/api", () => ({
  withApiAuth: (handler: unknown) => handler,
  requireScope: jest.fn(() => null), // caller holds content:delegate (tested elsewhere)
  createErrorResponse: (...a: unknown[]) =>
    createErrorResponseMock(...(a as [string, number, string])),
  createApiResponse: (...a: unknown[]) => createApiResponseMock(a[0]),
}));

// executeQuery dispatches by label: only the agent-identity lookup remains.
let agentRows: Array<{ scopes: string[]; name: string }> = [];
jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(async (_cb: unknown, label: string) => {
    if (label === "atrium.delegatedToken.findAgent") return agentRows;
    return [];
  }),
}));
jest.mock("@/lib/db/schema", () => ({
  agentIdentities: { scopes: "scopes", name: "name", oauthClientId: "oauthClientId", isActive: "isActive" },
}));
jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
}));

let roleNames: string[] = ["staff"];
jest.mock("@/lib/db/user-roles", () => ({
  getUserRoles: jest.fn(async () => roleNames),
}));

jest.mock("@/lib/content/helpers", () => ({
  systemUserIdOrNull: jest.fn(() => 999),
}));
jest.mock("@/lib/oauth/issuer-config", () => ({
  getIssuerUrl: jest.fn(() => "https://issuer.example"),
}));

// Capture what the route asks the signer to sign, and return an opaque token.
let signedClaims: Record<string, unknown> | null = null;
jest.mock("@/lib/oauth/jwt-signer", () => ({
  getJwtSigner: jest.fn(async () => ({
    signJwt: async (claims: Record<string, unknown>) => {
      signedClaims = claims;
      return "signed.jwt.token";
    },
  })),
}));

import { POST } from "@/app/api/v1/agents/delegated-token/route";

type Auth = {
  authType: "session" | "api_key" | "jwt";
  oauthClientId?: string;
  delegatedForUserId?: number;
  userId: number;
  cognitoSub: string;
  scopes: string[];
};

const AGENT_AUTH: Auth = {
  authType: "jwt",
  oauthClientId: "agent-client-1",
  userId: 999,
  cognitoSub: "sys",
  scopes: ["content:read", "content:create", "content:update", "content:publish_internal", "content:delegate"],
};

function req(body: unknown): { json: () => Promise<unknown> } {
  return { json: async () => body };
}

// withApiAuth is mocked to the identity, so POST is the raw (request, auth, requestId)
// handler — cast to that shape (the exported type is the wrapped 1-arg signature).
const rawPost = POST as unknown as (
  request: unknown,
  auth: unknown,
  requestId: string
) => Promise<unknown>;
const call = (auth: Auth, body: unknown) => rawPost(req(body), auth, "rid-1");

beforeEach(() => {
  agentRows = [{ scopes: AGENT_AUTH.scopes, name: "ship-reporter" }];
  roleNames = ["staff"];
  signedClaims = null;
  createErrorResponseMock.mockClear();
  createApiResponseMock.mockClear();
});

describe("POST /api/v1/agents/delegated-token — guards", () => {
  it("403s a session caller (not an OIDC agent)", async () => {
    await call({ ...AGENT_AUTH, authType: "session", oauthClientId: undefined }, { delegated_for: 42 });
    expect(createErrorResponseMock).toHaveBeenCalledWith("rid-1", 403, "FORBIDDEN", expect.any(String));
    expect(signedClaims).toBeNull();
  });

  it("403s an sk-key caller (api_key, no oauthClientId)", async () => {
    await call({ ...AGENT_AUTH, authType: "api_key", oauthClientId: undefined }, { delegated_for: 42 });
    expect(createErrorResponseMock).toHaveBeenCalledWith("rid-1", 403, "FORBIDDEN", expect.any(String));
  });

  it("403s a caller whose own token is already delegated (no re-delegation)", async () => {
    await call({ ...AGENT_AUTH, delegatedForUserId: 7 }, { delegated_for: 42 });
    expect(createErrorResponseMock).toHaveBeenCalledWith("rid-1", 403, "FORBIDDEN", expect.any(String));
    expect(signedClaims).toBeNull();
  });

  it("403s when the OIDC client is not an active agent identity", async () => {
    agentRows = [];
    await call(AGENT_AUTH, { delegated_for: 42 });
    expect(createErrorResponseMock).toHaveBeenCalledWith("rid-1", 403, "FORBIDDEN", expect.any(String));
  });

  it("400s an invalid body (missing delegated_for)", async () => {
    await call(AGENT_AUTH, {});
    expect(createErrorResponseMock).toHaveBeenCalledWith("rid-1", 400, "VALIDATION_ERROR", expect.any(String), expect.anything());
  });

  it("403 INSUFFICIENT_SCOPE (NOT a distinct 404) for an unknown user — no id enumeration", async () => {
    // An unknown user has no roles → getUserRoles [] → empty intersection. The
    // response is identical to a role-less user's, so a delegation-capable agent
    // cannot probe which user ids exist.
    roleNames = []; // getUserRoles returns [] for a nonexistent user
    await call(AGENT_AUTH, { delegated_for: 999999 });
    expect(createErrorResponseMock).toHaveBeenCalledWith("rid-1", 403, "INSUFFICIENT_SCOPE", expect.any(String));
    expect(signedClaims).toBeNull();
  });

  it("403 INSUFFICIENT_SCOPE when the user holds no content authority (de-roled)", async () => {
    roleNames = ["student"]; // no content scopes
    await call(AGENT_AUTH, { delegated_for: 42 });
    expect(createErrorResponseMock).toHaveBeenCalledWith("rid-1", 403, "INSUFFICIENT_SCOPE", expect.any(String));
    expect(signedClaims).toBeNull();
  });
});

describe("POST /api/v1/agents/delegated-token — minting", () => {
  it("signs claims bounded to agent ∩ staff-user content scopes (no publish_public)", async () => {
    const res = await call(AGENT_AUTH, { delegated_for: 42 });
    expect(signedClaims).not.toBeNull();
    expect(signedClaims!.sub).toBe("999"); // system user, not the human
    expect(signedClaims!.delegated_for).toBe(42);
    expect(signedClaims!.client_id).toBe("agent-client-1");
    const scope = signedClaims!.scope as string;
    expect(scope.split(" ").sort()).toEqual([
      "content:create",
      "content:publish_internal",
      "content:read",
      "content:update",
    ]);
    expect(scope).not.toContain("content:publish_public");
    expect(scope).not.toContain("content:delegate");
    // Response envelope echoes the granted scope + delegated_for, never the raw claims.
    expect(res).toMatchObject({ ok: true, data: { data: { access_token: "signed.jwt.token", token_type: "Bearer", delegated_for: 42 } } });
  });

  it("narrows to a requested subset (never widening past the intersection)", async () => {
    await call(AGENT_AUTH, { delegated_for: 42, scope: "content:read content:publish_public" });
    // publish_public requested but staff cannot → dropped; only read survives.
    expect((signedClaims!.scope as string)).toBe("content:read");
  });
});
