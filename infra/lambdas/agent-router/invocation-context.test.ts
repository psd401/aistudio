import { describe, expect, test } from "bun:test";
import {
  createInvocationContextToken,
  DEFAULT_INVOCATION_CONTEXT_TTL_SECONDS,
  MAX_INVOCATION_CONTEXT_TTL_SECONDS,
} from "./invocation-context";
import { JOB_INVOCATION_CONTEXT_TTL_S } from "./job-promotion";

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

  test("keeps the default lifetime at 15 minutes", () => {
    const token = createInvocationContextToken(
      SECRET,
      {
        actorEmail: "a@psd401.net",
        ownerEmail: "a@psd401.net",
        mode: "owner",
        sessionId: "s",
        workspacePrefix: "p",
      },
      { nowSeconds: 100, nonce: "default-lifetime" }
    );
    const payload = token.split(".")[1]!;
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as { issuedAt: number; expiresAt: number };

    const lifetime = claims.expiresAt - claims.issuedAt;
    expect(lifetime).toBe(DEFAULT_INVOCATION_CONTEXT_TTL_SECONDS);
    // 90s cold start + 550s interactive work + 200s bounded finalization.
    expect(lifetime).toBeGreaterThanOrEqual(90 + 550 + 200);
  });

  test("accepts job authority that outlives two-hour work and finalization", () => {
    const token = createInvocationContextToken(
      SECRET,
      {
        actorEmail: "a@psd401.net",
        ownerEmail: "a@psd401.net",
        mode: "owner",
        sessionId: "job-session",
        workspacePrefix: "p",
      },
      {
        nowSeconds: 100,
        ttlSeconds: JOB_INVOCATION_CONTEXT_TTL_S,
        nonce: "job-lifetime",
      }
    );
    const payload = token.split(".")[1]!;
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8")
    ) as { issuedAt: number; expiresAt: number };

    expect(claims.expiresAt - claims.issuedAt).toBe(
      JOB_INVOCATION_CONTEXT_TTL_S
    );
    expect(JOB_INVOCATION_CONTEXT_TTL_S).toBe(
      MAX_INVOCATION_CONTEXT_TTL_SECONDS
    );
  });

  test("rejects short secrets and lifetimes beyond the job ceiling", () => {
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
        { ttlSeconds: MAX_INVOCATION_CONTEXT_TTL_SECONDS + 1 }
      )
    ).toThrow(
      `between 30 and ${MAX_INVOCATION_CONTEXT_TTL_SECONDS}`
    );
  });
});
