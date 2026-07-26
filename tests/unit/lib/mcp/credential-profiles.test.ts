/** @jest-environment node */

import {
  assertCredentialProfileUpdate,
  resolveCredentialProfile,
} from "@/lib/mcp/credential-profiles";

describe("connector credential profiles", () => {
  const original = process.env.MCP_OAUTH_CREDENTIAL_PROFILES;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.MCP_OAUTH_CREDENTIAL_PROFILES;
    } else {
      process.env.MCP_OAUTH_CREDENTIAL_PROFILES = original;
    }
  });

  it("maps an opaque profile to its server-owned secret for an approved origin", () => {
    process.env.MCP_OAUTH_CREDENTIAL_PROFILES = JSON.stringify({
      canva_prod: {
        secretId: "psd-connectors/prod/canva",
        allowedOrigins: ["https://api.canva.com"],
      },
    });
    expect(
      resolveCredentialProfile("canva_prod", "https://api.canva.com/mcp")
    ).toEqual({
      secretId: "psd-connectors/prod/canva",
      allowedOrigins: ["https://api.canva.com"],
    });
  });

  it("rejects arbitrary secret ids and cross-origin profile reuse", () => {
    process.env.MCP_OAUTH_CREDENTIAL_PROFILES = JSON.stringify({
      canva_prod: {
        secretId: "psd-connectors/prod/canva",
        allowedOrigins: ["https://api.canva.com"],
      },
    });
    expect(() =>
      resolveCredentialProfile(
        "arn:aws:secretsmanager:us-west-2:123:secret:database",
        "https://api.canva.com"
      )
    ).toThrow(/profile id/);
    expect(() =>
      resolveCredentialProfile("canva_prod", "https://attacker.example/mcp")
    ).toThrow(/not approved/);
  });

  it("rejects URL-only retargeting of an existing credential profile", () => {
    process.env.MCP_OAUTH_CREDENTIAL_PROFILES = JSON.stringify({
      canva_prod: {
        secretId: "psd-connectors/prod/canva",
        allowedOrigins: ["https://api.canva.com"],
      },
    });
    expect(() =>
      assertCredentialProfileUpdate(
        { url: "https://api.canva.com/mcp", profileId: "canva_prod" },
        { url: "https://attacker.example/mcp" }
      )
    ).toThrow(/not approved/);
  });

  it("permits clearing a profile without dereferencing the old secret", () => {
    delete process.env.MCP_OAUTH_CREDENTIAL_PROFILES;
    expect(() =>
      assertCredentialProfileUpdate(
        { url: "https://api.canva.com/mcp", profileId: "legacy" },
        { profileId: null }
      )
    ).not.toThrow();
  });
});
