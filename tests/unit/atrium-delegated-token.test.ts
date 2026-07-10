/**
 * Unit tests for the delegated-token pure logic (Atrium §26.1, #1059) — the
 * security core of delegated minting: scope bounding + claim shape. No DB/signer.
 */

import {
  DELEGATED_TOKEN_TTL_SECONDS,
  DELEGATION_AUTHORITY_SCOPE,
  intersectDelegatedScopes,
  buildDelegatedTokenClaims,
} from "@/lib/oauth/delegated-token";

// Role-derived scope sets used across tests (mirror lib/api-keys/scopes.ts).
const STAFF = [
  "chat:read",
  "chat:write",
  "content:read",
  "content:create",
  "content:update",
  "content:publish_internal",
];
const ADMIN = [
  ...STAFF,
  "content:publish_public",
  DELEGATION_AUTHORITY_SCOPE, // admin inherits ALL_SCOPES, incl. the authority scope
];
const AGENT_FULL = [
  "content:read",
  "content:create",
  "content:update",
  "content:publish_internal",
  "content:publish_public",
  DELEGATION_AUTHORITY_SCOPE,
];

describe("intersectDelegatedScopes", () => {
  it("returns agent ∩ user (content only) when no scope is requested", () => {
    const scopes = intersectDelegatedScopes(null, AGENT_FULL, STAFF);
    expect(scopes).toEqual([
      "content:create",
      "content:publish_internal",
      "content:read",
      "content:update",
    ]);
  });

  it("NEVER grants a staff delegation content:publish_public (bounded by the user)", () => {
    const scopes = intersectDelegatedScopes(null, AGENT_FULL, STAFF);
    expect(scopes).not.toContain("content:publish_public");
  });

  it("grants publish_public only when BOTH the admin user AND the agent hold it", () => {
    expect(intersectDelegatedScopes(null, AGENT_FULL, ADMIN)).toContain(
      "content:publish_public"
    );
    // Agent lacks it → excluded even for an admin user (double-gate).
    const weakAgent = ["content:read", "content:create"];
    expect(intersectDelegatedScopes(null, weakAgent, ADMIN)).not.toContain(
      "content:publish_public"
    );
  });

  it("NEVER includes the content:delegate authority scope, even when both hold it", () => {
    const scopes = intersectDelegatedScopes(null, AGENT_FULL, ADMIN);
    expect(scopes).not.toContain(DELEGATION_AUTHORITY_SCOPE);
  });

  it("drops non-content and unknown requested scopes (pure content credential)", () => {
    const scopes = intersectDelegatedScopes(
      ["chat:write", "content:create", "content:read", "totally:made-up"],
      AGENT_FULL,
      STAFF
    );
    expect(scopes).toEqual(["content:create", "content:read"]);
  });

  it("narrows to the requested subset without ever widening past the intersection", () => {
    // Requests publish_public but the staff user cannot → it drops out.
    const scopes = intersectDelegatedScopes(
      ["content:create", "content:publish_public"],
      AGENT_FULL,
      STAFF
    );
    expect(scopes).toEqual(["content:create"]);
  });

  it("returns an empty set when the user holds no content authority (de-roled)", () => {
    expect(intersectDelegatedScopes(null, AGENT_FULL, ["chat:read"])).toEqual([]);
    expect(intersectDelegatedScopes(null, AGENT_FULL, [])).toEqual([]);
  });
});

describe("buildDelegatedTokenClaims", () => {
  const claims = buildDelegatedTokenClaims({
    systemUserId: "999",
    delegatedForUserId: 42,
    agentClientId: "agent-client-uuid",
    scopes: ["content:create", "content:read"],
    issuer: "https://issuer.example",
    nowSeconds: 1_000_000,
    jti: "jti-123",
  });

  it("sets sub to the SYSTEM user, not the human (blast-radius containment)", () => {
    expect(claims.sub).toBe("999");
    expect(claims.sub).not.toBe("42");
  });

  it("emits a NUMERIC delegated_for (the resolver trigger)", () => {
    expect(claims.delegated_for).toBe(42);
    expect(typeof claims.delegated_for).toBe("number");
  });

  it("carries a NON-numeric act.sub (agent client id) so it is not mis-read as delegated_for", () => {
    expect(claims.act).toEqual({ sub: "agent-client-uuid" });
    // The consumer treats a numeric act.sub as a delegated_for fallback; a client id
    // must yield NaN so it is ignored.
    expect(Number.isNaN(Number((claims.act as { sub: string }).sub))).toBe(true);
  });

  it("attributes the agent via client_id + azp", () => {
    expect(claims.client_id).toBe("agent-client-uuid");
    expect(claims.azp).toBe("agent-client-uuid");
  });

  it("space-delimits the scope string and sets exp = iat + TTL", () => {
    expect(claims.scope).toBe("content:create content:read");
    expect(claims.iat).toBe(1_000_000);
    expect((claims.exp as number) - (claims.iat as number)).toBe(
      DELEGATED_TOKEN_TTL_SECONDS
    );
  });

  it("keeps the TTL short (minutes-scale, ≤ the 900s access-token TTL)", () => {
    expect(DELEGATED_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(300);
    expect(DELEGATED_TOKEN_TTL_SECONDS).toBeLessThan(900);
  });
});
