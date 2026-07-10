/**
 * Unit tests for the initial-inbox sweep state machine (#1172).
 *
 * Exercises pagination, the 1000-message cap, and — most importantly —
 * RESUMABILITY: a sweep persists its page cursor + counts and a
 * continuation picks up exactly where the prior slice stopped, running to
 * completion. Dependencies are injected (no AWS / Gmail).
 *
 * Run: bun test sweep.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  runSweepSlice,
  newSweepState,
  SWEEP_PAGE_SIZE,
  type SweepDeps,
} from "./sweep";
import type { DecisionRecord, SweepState, TriageRow } from "./types";

function makeRow(sweep?: SweepState): TriageRow {
  return {
    userEmail: "u@psd401.net",
    enabled: true,
    labels: {},
    labelIdsByKey: {},
    rules: { vipSenders: [], muteSenders: [], keywordRules: [] },
    escalation: { senders: [], keywords: [], labelTriggers: ["important"] },
    digestEnabled: false,
    recentDecisions: [],
    recentCorrections: [],
    sweep,
  };
}

function msgs(n: number, prefix = "m"): { id: string; threadId: string }[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, threadId: `${prefix}${i}` }));
}

/**
 * Build a deps harness backed by an in-memory page map + a persisted-state
 * capture, mirroring how the worker re-reads the row between slices.
 */
function harness(pages: Record<string, { messages: { id: string; threadId: string }[]; nextPageToken?: string }>) {
  const persisted: Array<{ decisions: DecisionRecord[]; sweep: SweepState }> = [];
  const listCalls: Array<string | undefined> = [];
  const deps: SweepDeps = {
    acquireAccessToken: async () => "tok",
    listInboxMessages: async (_t, opts) => {
      listCalls.push(opts?.pageToken);
      const key = opts?.pageToken ?? "start";
      return pages[key] ?? { messages: [] };
    },
    classifyAndLabel: async (_row, _tok, ref) => ({
      decision: {
        messageId: ref.id,
        threadId: ref.threadId,
        label: "later",
        source: "llm",
        reason: "r",
        confidence: 0.5,
        ts: "2026-07-10T00:00:00Z",
        fromEmail: "x@vendor.com",
        subject: "s",
      },
      escalated: false,
    }),
    recordSweepSlice: async (_u, decisions, sweep) => {
      persisted.push({ decisions, sweep });
    },
  };
  return { deps, persisted, listCalls };
}

describe("runSweepSlice", () => {
  test("single page, no continuation → complete", async () => {
    const { deps, persisted } = harness({
      start: { messages: msgs(10) }, // no nextPageToken
    });
    const out = await runSweepSlice(makeRow(newSweepState()), deps);
    expect(out.sweep.status).toBe("complete");
    expect(out.shouldContinue).toBe(false);
    expect(out.sweep.processed).toBe(10);
    expect(out.sweep.labeled).toBe(10);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].decisions).toHaveLength(10);
  });

  test("multi-page sweep is resumable across slices to completion", async () => {
    const pages = {
      start: { messages: msgs(SWEEP_PAGE_SIZE, "a"), nextPageToken: "p2" },
      p2: { messages: msgs(20, "b") }, // last page
    };
    const { deps, listCalls } = harness(pages);

    // Slice 1 — full page, more to come.
    const s1 = await runSweepSlice(makeRow(newSweepState()), deps);
    expect(s1.sweep.status).toBe("running");
    expect(s1.shouldContinue).toBe(true);
    expect(s1.sweep.pageToken).toBe("p2");
    expect(s1.sweep.processed).toBe(SWEEP_PAGE_SIZE);

    // Slice 2 — resume from the persisted cursor; row carries s1's sweep.
    const s2 = await runSweepSlice(makeRow(s1.sweep), deps);
    expect(s2.sweep.status).toBe("complete");
    expect(s2.shouldContinue).toBe(false);
    expect(s2.sweep.processed).toBe(SWEEP_PAGE_SIZE + 20);

    // The second slice resumed from the saved page token (not from start).
    expect(listCalls).toEqual([undefined, "p2"]);
  });

  test("honours the message cap (stops at cap even with more pages)", async () => {
    const capped: SweepState = { ...newSweepState(), cap: 4 };
    const { deps } = harness({
      start: { messages: msgs(50), nextPageToken: "p2" },
    });
    const out = await runSweepSlice(makeRow(capped), deps);
    expect(out.sweep.processed).toBe(4);
    expect(out.sweep.status).toBe("complete");
    expect(out.shouldContinue).toBe(false);
  });

  test("already-complete sweep is an idempotent no-op", async () => {
    const done: SweepState = { ...newSweepState(), status: "complete", processed: 100, labeled: 90 };
    const { deps, persisted, listCalls } = harness({ start: { messages: msgs(10) } });
    const out = await runSweepSlice(makeRow(done), deps);
    expect(out.sweep).toEqual(done);
    expect(out.shouldContinue).toBe(false);
    expect(persisted).toHaveLength(0);
    expect(listCalls).toHaveLength(0);
  });

  test("no access token → error status, no continuation", async () => {
    const { deps } = harness({ start: { messages: msgs(10) } });
    const noToken: SweepDeps = { ...deps, acquireAccessToken: async () => null };
    const out = await runSweepSlice(makeRow(newSweepState()), noToken);
    expect(out.sweep.status).toBe("error");
    expect(out.sweep.error).toBe("no-access-token");
    expect(out.shouldContinue).toBe(false);
  });

  test("a Gmail failure marks error and preserves the resume cursor", async () => {
    const { deps } = harness({});
    const boom: SweepDeps = {
      ...deps,
      listInboxMessages: async () => {
        throw new Error("gmail 503");
      },
    };
    const prior: SweepState = { ...newSweepState(), status: "running", pageToken: "pX", processed: 30 };
    const out = await runSweepSlice(makeRow(prior), boom);
    expect(out.sweep.status).toBe("error");
    expect(out.sweep.pageToken).toBe("pX"); // cursor preserved for a manual resume
    expect(out.sweep.processed).toBe(30);
    expect(out.shouldContinue).toBe(false);
  });
});
