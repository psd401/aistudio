/**
 * Unit tests for the §28.3 agent content screening core (Epic #1059 completion,
 * `lib/content/agent-screening.ts`) — the module extracted from the agent-bridge
 * route so every agent write path screens through one implementation.
 *
 * Covers:
 *  - `screenAgentContent`: blocked → blocked verdict (guardrails message
 *    surfaced), degraded → FAIL-CLOSED degraded verdict, allowed → PII detected
 *    + logged (telemetry only, non-fatal on detector failure).
 *  - `screenAgentBodyForWrite` (the content-service write gate): screens any
 *    AGENT requester — autonomous OR delegated (`isAgentRequester`) — with a
 *    non-empty body; a human author never touches the safety stack (zero
 *    behavior change); blocked / degraded content throws a fail-closed
 *    `ValidationError` with the bridge's user-facing semantics.
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
  AGENT_SCREEN_BLOCKED_MESSAGE,
  AGENT_SCREEN_DEGRADED_MESSAGE,
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

  it("FAILS CLOSED on a degraded evaluation (guardrails unavailable)", async () => {
    // The shared guardrails service fails OPEN (allowed:true, degraded:true) on
    // an AWS error — unacceptable for persisted agent content, so the screening
    // core must convert it into a rejection.
    checkResult = { allowed: true, degraded: true };
    const verdict = await screenAgentContent("any text", "obj-1");
    expect(verdict).toEqual({
      allowed: false,
      reason: "degraded",
      message: AGENT_SCREEN_DEGRADED_MESSAGE,
    });
    expect(detectPIIMock).not.toHaveBeenCalled();
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
    checkResult = { allowed: true, degraded: true };
    const verdict = await screenAgentContent("any text", "obj-1");
    expect(verdict).toEqual({
      allowed: false,
      reason: "degraded",
      message: AGENT_SCREEN_DEGRADED_MESSAGE,
    });
    // Exact-match: no `requestId` key sneaks in when the caller has none.
    expect(createLoggerMock).toHaveBeenCalledWith({
      module: "atrium-agent-screening",
    });
  });
});

describe("screenAgentBodyForWrite (the content-service write gate)", () => {
  it("never screens a human author (zero behavior change)", async () => {
    checkResult = { allowed: false }; // would block IF screened
    await expect(
      screenAgentBodyForWrite(humanUser, "# anything", null)
    ).resolves.toBeUndefined();
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
    await expect(
      screenAgentBodyForWrite(delegatedAgent, "# clean", "obj-1")
    ).resolves.toBeUndefined();
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
    ).resolves.toBeUndefined();
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

  it("throws ValidationError (fail closed) when screening is degraded/unavailable", async () => {
    checkResult = { allowed: true, degraded: true };
    await expect(
      screenAgentBodyForWrite(autonomousAgent, "# any", "obj-1")
    ).rejects.toThrow(/Safety screening unavailable/);
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
