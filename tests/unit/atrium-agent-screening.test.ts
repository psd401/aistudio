/**
 * Unit tests for the §28.3 agent content screening core (Epic #1059 completion,
 * `lib/content/agent-screening.ts`) — the module extracted from the agent-bridge
 * route so every agent write path screens through one implementation.
 *
 * Covers:
 *  - `screenAgentContent`: blocked → blocked verdict (guardrails message
 *    surfaced), degraded → FAIL-OPEN (allowed, telemetry logged), allowed → PII
 *    detected + logged (telemetry only, non-fatal on detector failure).
 *  - `screenAgentBodyForWrite` (the content-service write gate): screens any
 *    AGENT requester — autonomous OR delegated (`isAgentRequester`) — with a
 *    non-empty body; a human author never touches the safety stack (zero
 *    behavior change); a positive guardrails detection throws a `ValidationError`
 *    with the bridge's user-facing semantics, while a degraded evaluation fails
 *    OPEN and never throws.
 *
 * Only the lazily-imported `@/lib/safety` boundary is mocked; the REAL
 * `isAgentRequester` helper runs so the machine-authorship gate is exercised.
 */

interface FakeSafetyResult {
  allowed: boolean;
  degraded?: boolean;
  blockedReason?: string;
  blockedMessage?: string;
  blockedCategories?: string[];
}

let checkResult: FakeSafetyResult = { allowed: true };
let piiEntities: unknown[] = [];
let piiThrows = false;

const checkInputSafetyMock = jest.fn(async (..._args: unknown[]) => checkResult);
const detectPIIMock = jest.fn(async (..._args: unknown[]) => {
  if (piiThrows) throw new Error("comprehend unavailable");
  return piiEntities;
});

// The module imports @/lib/safety LAZILY (await import inside the function);
// jest's module registry intercepts dynamic imports the same as static ones.
jest.mock("@/lib/safety", () => ({
  getContentSafetyService: () => ({
    checkInputSafety: (...args: unknown[]) => checkInputSafetyMock(...args),
  }),
  getPIITokenizationService: () => ({
    detectPII: (...args: unknown[]) => detectPIIMock(...args),
  }),
}));

// `@/lib/logger` is mocked GLOBALLY in jest.setup.js (createLogger is already a
// jest.fn there) — the requestId-correlation tests below assert on its context
// arg to verify the security-relevant blocked/degraded log lines carry the
// caller's requestId.

import {
  screenAgentContent,
  screenAgentBodyForWrite,
  assertScreened,
  AGENT_SCREEN_BLOCKED_MESSAGE,
  type ScreeningProof,
} from "@/lib/content/agent-screening";
import { ValidationError } from "@/lib/content/errors";
import { createLogger } from "@/lib/logger";
import type { Requester } from "@/lib/content/types";

// The globally mocked createLogger (see jest.setup.js), typed for assertions.
const createLoggerMock = createLogger as unknown as jest.Mock;

const humanUser: Requester = {
  kind: "user",
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};
// Delegated agents record as 'human' (actorKindOf) — they act AS their human.
const delegatedAgent: Requester = {
  kind: "agent-delegated",
  actingForUserId: 7,
  roles: ["staff"],
  scopes: ["content:create", "content:update"],
  agentLabel: "helper-bot",
};
const autonomousAgent: Requester = {
  kind: "agent-autonomous",
  agentId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  roleId: null,
  roles: ["staff"],
  scopes: ["content:create", "content:update"],
  agentLabel: "ship-reporter",
};

beforeEach(() => {
  checkResult = { allowed: true };
  piiEntities = [];
  piiThrows = false;
  checkInputSafetyMock.mockClear();
  detectPIIMock.mockClear();
  createLoggerMock.mockClear();
});

describe("screenAgentContent", () => {
  it("returns a blocked verdict with the guardrails message when content is blocked", async () => {
    checkResult = {
      allowed: false,
      blockedReason: "HATE",
      blockedMessage: "This violates policy X.",
      blockedCategories: ["HATE"],
    };
    const verdict = await screenAgentContent("bad text", "obj-1");
    expect(verdict).toEqual({
      allowed: false,
      reason: "blocked",
      message: "This violates policy X.",
    });
    // Blocked content never reaches the PII detector.
    expect(detectPIIMock).not.toHaveBeenCalled();
  });

  it("falls back to the generic blocked message when guardrails supply none", async () => {
    checkResult = { allowed: false };
    const verdict = await screenAgentContent("bad text", null);
    expect(verdict).toEqual({
      allowed: false,
      reason: "blocked",
      message: AGENT_SCREEN_BLOCKED_MESSAGE,
    });
  });

  it("FAILS OPEN on a degraded evaluation (guardrails unavailable → allowed)", async () => {
    // Guardrails are telemetry-only here: a degraded evaluation (AWS error /
    // ApplyGuardrail AccessDenied / throttle) must NOT block the write. The core
    // allows the content, logs the skipped guardrails evaluation, and STILL runs
    // PII detection — the write persists, so it must keep its student-data
    // telemetry (Comprehend is independent of the degraded Bedrock guardrail).
    checkResult = { allowed: true, degraded: true };
    const verdict = await screenAgentContent("any text", "obj-1");
    expect(verdict).toEqual({ allowed: true });
    expect(detectPIIMock).toHaveBeenCalledWith("any text");
  });

  it("allows clean content and runs PII detection as telemetry", async () => {
    piiEntities = [{ Type: "NAME" }];
    const verdict = await screenAgentContent("clean text", "obj-1");
    expect(verdict).toEqual({ allowed: true });
    expect(checkInputSafetyMock).toHaveBeenCalledWith("clean text", "obj-1");
    expect(detectPIIMock).toHaveBeenCalledWith("clean text");
  });

  it("treats a PII detector failure as non-fatal (content still allowed)", async () => {
    piiThrows = true;
    const verdict = await screenAgentContent("clean text", null);
    expect(verdict).toEqual({ allowed: true });
  });

  it("threads the caller's requestId onto the screening logger for a blocked write", async () => {
    checkResult = { allowed: false, blockedMessage: "Nope." };
    const verdict = await screenAgentContent("bad text", "obj-1", "req-abc123");
    // The verdict is unchanged by the correlation param…
    expect(verdict).toEqual({
      allowed: false,
      reason: "blocked",
      message: "Nope.",
    });
    // …but the security-relevant "blocked" log line is request-correlated.
    expect(createLoggerMock).toHaveBeenCalledWith({
      module: "atrium-agent-screening",
      requestId: "req-abc123",
    });
  });

  it("omits requestId from the logger context when none is provided (today's behavior)", async () => {
    // The degraded path still creates the (telemetry) logger; it just allows.
    checkResult = { allowed: true, degraded: true };
    const verdict = await screenAgentContent("any text", "obj-1");
    expect(verdict).toEqual({ allowed: true });
    // Exact-match: no `requestId` key sneaks in when the caller has none.
    expect(createLoggerMock).toHaveBeenCalledWith({
      module: "atrium-agent-screening",
    });
  });
});

describe("screenAgentBodyForWrite (the content-service write gate)", () => {
  it("never screens a human author (zero behavior change)", async () => {
    checkResult = { allowed: false }; // would block IF screened
    // Returns a "screening not required" proof (screenedBody null) — no screening.
    await expect(
      screenAgentBodyForWrite(humanUser, "# anything", null)
    ).resolves.toMatchObject({ screenedBody: null });
    expect(checkInputSafetyMock).not.toHaveBeenCalled();
  });

  it("SCREENS a delegated agent — machine authorship, not provenance, gates screening", async () => {
    // A delegated agent records provenance as the human it acts for
    // (actorKindOf → 'human'), but it is still a machine generating content, so
    // §28.3 must apply. Guardrails blocks here → the write is rejected.
    checkResult = { allowed: false, blockedMessage: "Nope." };
    await expect(
      screenAgentBodyForWrite(delegatedAgent, "# anything", "obj-1")
    ).rejects.toThrow(/Content blocked by safety policy/);
    expect(checkInputSafetyMock).toHaveBeenCalledTimes(1);
  });

  it("allows a clean delegated-agent body (screened and passed)", async () => {
    checkResult = { allowed: true };
    // The proof binds to the EXACT screened body (issue #1118 item 3).
    await expect(
      screenAgentBodyForWrite(delegatedAgent, "# clean", "obj-1")
    ).resolves.toMatchObject({ screenedBody: "# clean" });
    expect(checkInputSafetyMock).toHaveBeenCalledTimes(1);
  });

  it("skips screening for a missing or whitespace-only body", async () => {
    await screenAgentBodyForWrite(autonomousAgent, undefined, null);
    await screenAgentBodyForWrite(autonomousAgent, "   \n\t ", null);
    expect(checkInputSafetyMock).not.toHaveBeenCalled();
  });

  it("allows a clean autonomous-agent body", async () => {
    await expect(
      screenAgentBodyForWrite(autonomousAgent, "# clean", "obj-1")
    ).resolves.toMatchObject({ screenedBody: "# clean" });
    expect(checkInputSafetyMock).toHaveBeenCalledTimes(1);
  });

  it("throws ValidationError with the bridge's blocked semantics on blocked content", async () => {
    checkResult = { allowed: false, blockedMessage: "Nope." };
    await expect(
      screenAgentBodyForWrite(autonomousAgent, "# bad", "obj-1")
    ).rejects.toThrow(/Content blocked by safety policy/);
    await expect(
      screenAgentBodyForWrite(autonomousAgent, "# bad", "obj-1")
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("does NOT throw (fails open) when screening is degraded/unavailable", async () => {
    checkResult = { allowed: true, degraded: true };
    // Fails open → returns a proof (content allowed) rather than throwing.
    await expect(
      screenAgentBodyForWrite(autonomousAgent, "# any", "obj-1")
    ).resolves.toMatchObject({ screenedBody: "# any" });
    // Screening was attempted (telemetry) even though it degraded to allow.
    expect(checkInputSafetyMock).toHaveBeenCalledTimes(1);
  });

  it("passes an optional requestId through to the screening logger without changing the verdict", async () => {
    checkResult = { allowed: false, blockedMessage: "Nope." };
    await expect(
      screenAgentBodyForWrite(autonomousAgent, "# bad", "obj-1", "req-write-9")
    ).rejects.toThrow(/Content blocked by safety policy/);
    expect(createLoggerMock).toHaveBeenCalledWith({
      module: "atrium-agent-screening",
      requestId: "req-write-9",
    });
  });
});

describe("assertScreened (the shared-write-primitive guard, issue #1118 item 3)", () => {
  it("passes when the proof matches the exact screened agent body", async () => {
    checkResult = { allowed: true };
    const proof = await screenAgentBodyForWrite(autonomousAgent, "# clean", "o1");
    expect(() => assertScreened(autonomousAgent, "# clean", proof, "o1")).not.toThrow();
  });

  it("THROWS when the proof was for a DIFFERENT body (stale/mismatched proof)", async () => {
    checkResult = { allowed: true };
    const proof = await screenAgentBodyForWrite(autonomousAgent, "# screened", "o1");
    // A future caller screens body A then snapshots body B — must fail loudly.
    expect(() =>
      assertScreened(autonomousAgent, "# DIFFERENT body", proof, "o1")
    ).toThrow(ValidationError);
  });

  it("THROWS on a fabricated proof (missing the module-private brand)", () => {
    // A caller cannot forge a ScreeningProof: the brand symbol is module-private,
    // so a hand-built object fails the guard even if screenedBody matches.
    const fake = { screenedBody: "# agent body" } as unknown as ScreeningProof;
    expect(() =>
      assertScreened(autonomousAgent, "# agent body", fake, "o1")
    ).toThrow(ValidationError);
  });

  it("is a NO-OP for a human writer (screening never required)", () => {
    const fake = {} as unknown as ScreeningProof;
    expect(() => assertScreened(humanUser, "# human wrote this", fake, "o1")).not.toThrow();
  });

  it("is a NO-OP for an empty agent body (nothing to screen)", () => {
    const fake = {} as unknown as ScreeningProof;
    expect(() => assertScreened(autonomousAgent, "   ", fake, "o1")).not.toThrow();
  });
});
