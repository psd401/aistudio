import { describe, expect, test } from "bun:test";
import { createInvocationContextToken } from "./invocation-context";

const SECRET = "0123456789abcdef0123456789abcdef";

describe("createInvocationContextToken", () => {
  test("binds normalized actor, owner, mode, session, prefix, and expiry", () => {
    const token = createInvocationContextToken(
      SECRET,
      {
        actorEmail: "Actor@PSD401.NET",
        ownerEmail: "Owner@PSD401.NET",
        mode: "consultation",
        sessionId: "session-1",
        workspacePrefix: "users/owner/",
      },
      { nowSeconds: 100, ttlSeconds: 60, nonce: "nonce-1" }
    );

    const [version, payload] = token.split(".");
    expect(version).toBe("v1");
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"))).toEqual({
      version: 1,
      audience: "psd-agent-internal",
      actorEmail: "actor@psd401.net",
      ownerEmail: "owner@psd401.net",
      mode: "consultation",
      sessionId: "session-1",
      workspacePrefix: "users/owner/",
      issuedAt: 100,
      expiresAt: 160,
      nonce: "nonce-1",
    });
  });

  test("rejects short secrets and overlong lifetimes", () => {
    expect(() =>
      createInvocationContextToken("short", {
        actorEmail: "a@psd401.net",
        ownerEmail: "a@psd401.net",
        mode: "owner",
        sessionId: "s",
        workspacePrefix: "p",
      })
    ).toThrow("at least 32 bytes");

    expect(() =>
      createInvocationContextToken(
        SECRET,
        {
          actorEmail: "a@psd401.net",
          ownerEmail: "a@psd401.net",
          mode: "owner",
          sessionId: "s",
          workspacePrefix: "p",
        },
        { ttlSeconds: 901 }
      )
    ).toThrow("between 30 and 900");
  });
});
