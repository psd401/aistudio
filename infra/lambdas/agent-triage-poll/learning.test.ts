/**
 * Unit tests for the correction-driven learning algorithm (#1172).
 *
 * Run: bun test learning.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  computeLearning,
  mergeSuggestions,
  SUGGESTION_MIN_COUNT,
} from "./learning";
import type {
  CorrectionRecord,
  DecisionRecord,
  Suggestion,
  TriageRules,
} from "./types";

const emptyRules: TriageRules = {
  vipSenders: [],
  muteSenders: [],
  keywordRules: [],
};

const NOW = Date.parse("2026-07-10T12:00:00Z");

function correction(
  over: Partial<CorrectionRecord> & Pick<CorrectionRecord, "toLabel">,
): CorrectionRecord {
  return {
    messageId: over.messageId ?? Math.random().toString(36).slice(2),
    fromLabel: over.fromLabel ?? "later",
    toLabel: over.toLabel,
    ts: over.ts ?? "2026-07-10T00:00:00Z",
    fromEmail: over.fromEmail,
    fromDomain: over.fromDomain,
  };
}

describe("computeLearning", () => {
  test("no corrections → empty result", () => {
    const r = computeLearning({ corrections: [], decisions: [], rules: emptyRules, now: NOW });
    expect(r.learnedPatterns).toEqual([]);
    expect(r.suggestions).toEqual([]);
  });

  test("repeated archives of important → mute suggestion + pattern", () => {
    const corrections = [
      correction({ toLabel: "archived", fromLabel: "important", fromEmail: "noise@vendor.com" }),
      correction({ toLabel: "archived", fromLabel: "important", fromEmail: "noise@vendor.com" }),
      correction({ toLabel: "archived", fromLabel: "important", fromEmail: "noise@vendor.com" }),
    ];
    const r = computeLearning({ corrections, decisions: [], rules: emptyRules, now: NOW });
    expect(r.learnedPatterns).toHaveLength(1);
    expect(r.learnedPatterns[0]).toMatchObject({ pattern: "noise@vendor.com", kind: "mute", count: 3 });
    expect(r.suggestions).toHaveLength(1);
    expect(r.suggestions[0]).toMatchObject({
      id: "mute:noise@vendor.com",
      kind: "mute",
      target: "noise@vendor.com",
      count: 3,
    });
    expect(r.suggestions[0].reason).toContain("mute");
  });

  test("repeated rescues (later → inbox) → vip suggestion", () => {
    const corrections = [
      correction({ toLabel: "inbox", fromLabel: "later", fromEmail: "boss@psd401.net" }),
      correction({ toLabel: "inbox", fromLabel: "later", fromEmail: "boss@psd401.net" }),
    ];
    const r = computeLearning({ corrections, decisions: [], rules: emptyRules, now: NOW });
    expect(r.suggestions[0]).toMatchObject({ id: "vip:boss@psd401.net", kind: "vip", count: 2 });
  });

  test("direct re-label to important is a vip signal", () => {
    const corrections = [
      correction({ toLabel: "important", fromLabel: "later", fromEmail: "boss@psd401.net" }),
      correction({ toLabel: "important", fromLabel: "news", fromEmail: "boss@psd401.net" }),
    ];
    const r = computeLearning({ corrections, decisions: [], rules: emptyRules, now: NOW });
    expect(r.suggestions[0]).toMatchObject({ id: "vip:boss@psd401.net" });
  });

  test("single correction is a pattern but NOT yet a suggestion", () => {
    const corrections = [
      correction({ toLabel: "archived", fromLabel: "important", fromEmail: "x@vendor.com" }),
    ];
    const r = computeLearning({ corrections, decisions: [], rules: emptyRules, now: NOW });
    // One fresh correction ≈ weight 1.0 → above LEARN_MIN_WEIGHT (pattern)
    // but below SUGGESTION_MIN_WEIGHT / min-count (no suggestion).
    expect(r.learnedPatterns).toHaveLength(1);
    expect(r.suggestions).toHaveLength(0);
    expect(SUGGESTION_MIN_COUNT).toBe(2);
  });

  test("sender resolved by joining corrections to decisions when fromEmail absent", () => {
    const decisions: DecisionRecord[] = [
      {
        messageId: "m1",
        threadId: "t1",
        label: "important",
        source: "llm",
        reason: "x",
        confidence: 0.8,
        ts: "2026-07-09T00:00:00Z",
        fromEmail: "joinme@vendor.com",
        subject: "s",
      },
      {
        messageId: "m2",
        threadId: "t2",
        label: "important",
        source: "llm",
        reason: "x",
        confidence: 0.8,
        ts: "2026-07-09T00:00:00Z",
        fromEmail: "joinme@vendor.com",
        subject: "s",
      },
    ];
    const corrections = [
      correction({ messageId: "m1", toLabel: "archived", fromLabel: "important" }),
      correction({ messageId: "m2", toLabel: "archived", fromLabel: "important" }),
    ];
    const r = computeLearning({ corrections, decisions, rules: emptyRules, now: NOW });
    expect(r.suggestions[0]).toMatchObject({ id: "mute:joinme@vendor.com" });
  });

  test("corrections with unresolvable sender are ignored", () => {
    const corrections = [
      correction({ messageId: "orphan", toLabel: "archived", fromLabel: "important" }),
      correction({ messageId: "orphan2", toLabel: "archived", fromLabel: "important" }),
    ];
    const r = computeLearning({ corrections, decisions: [], rules: emptyRules, now: NOW });
    expect(r.learnedPatterns).toEqual([]);
    expect(r.suggestions).toEqual([]);
  });

  test("already-VIP sender is not re-suggested", () => {
    const corrections = [
      correction({ toLabel: "inbox", fromLabel: "later", fromEmail: "boss@psd401.net" }),
      correction({ toLabel: "inbox", fromLabel: "later", fromEmail: "boss@psd401.net" }),
    ];
    const r = computeLearning({
      corrections,
      decisions: [],
      rules: { ...emptyRules, vipSenders: ["boss@psd401.net"] },
      now: NOW,
    });
    expect(r.suggestions).toHaveLength(0);
    // still surfaced as a soft pattern
    expect(r.learnedPatterns).toHaveLength(1);
  });

  test("already-muted (wildcard) sender is not re-suggested", () => {
    const corrections = [
      correction({ toLabel: "archived", fromLabel: "important", fromEmail: "noreply@vendor.com" }),
      correction({ toLabel: "archived", fromLabel: "important", fromEmail: "noreply@vendor.com" }),
    ];
    const r = computeLearning({
      corrections,
      decisions: [],
      rules: { ...emptyRules, muteSenders: ["noreply@*"] },
      now: NOW,
    });
    expect(r.suggestions).toHaveLength(0);
  });

  test("dismissed suggestion id is not re-raised", () => {
    const corrections = [
      correction({ toLabel: "archived", fromLabel: "important", fromEmail: "x@vendor.com" }),
      correction({ toLabel: "archived", fromLabel: "important", fromEmail: "x@vendor.com" }),
    ];
    const r = computeLearning({
      corrections,
      decisions: [],
      rules: emptyRules,
      dismissedSuggestionIds: ["mute:x@vendor.com"],
      now: NOW,
    });
    expect(r.suggestions).toHaveLength(0);
  });

  test("conflicting equal signals cancel (ambiguous, dropped)", () => {
    const corrections = [
      correction({ toLabel: "archived", fromLabel: "important", fromEmail: "mixed@x.com", ts: "2026-07-10T00:00:00Z" }),
      correction({ toLabel: "inbox", fromLabel: "later", fromEmail: "mixed@x.com", ts: "2026-07-10T00:00:00Z" }),
    ];
    const r = computeLearning({ corrections, decisions: [], rules: emptyRules, now: NOW });
    expect(r.learnedPatterns).toEqual([]);
  });

  test("old corrections decay below fresh ones", () => {
    const fresh = Array.from({ length: 3 }, () =>
      correction({ toLabel: "archived", fromLabel: "important", fromEmail: "fresh@x.com", ts: "2026-07-10T00:00:00Z" }),
    );
    const old = Array.from({ length: 3 }, () =>
      correction({ toLabel: "archived", fromLabel: "important", fromEmail: "old@x.com", ts: "2026-01-10T00:00:00Z" }),
    );
    const r = computeLearning({ corrections: [...fresh, ...old], decisions: [], rules: emptyRules, now: NOW });
    const freshP = r.learnedPatterns.find((p) => p.pattern === "fresh@x.com")!;
    const oldP = r.learnedPatterns.find((p) => p.pattern === "old@x.com");
    expect(freshP.weight).toBeGreaterThan(oldP?.weight ?? 0);
  });
});

describe("mergeSuggestions", () => {
  const s = (id: string, createdAt = "2026-07-01T00:00:00Z"): Suggestion => ({
    id,
    kind: id.startsWith("vip") ? "vip" : "mute",
    target: id.split(":")[1],
    reason: "r",
    count: 3,
    weight: 2,
    createdAt,
  });

  test("adds only genuinely new suggestions", () => {
    const existing = [s("mute:a@x.com")];
    const fresh = [s("mute:a@x.com", "2026-07-10T00:00:00Z"), s("vip:b@x.com")];
    const { merged, added } = mergeSuggestions(existing, fresh);
    expect(merged.map((m) => m.id).sort()).toEqual(["mute:a@x.com", "vip:b@x.com"]);
    expect(added.map((a) => a.id)).toEqual(["vip:b@x.com"]);
  });

  test("preserves original createdAt for existing ids", () => {
    const existing = [s("mute:a@x.com", "2026-06-01T00:00:00Z")];
    const fresh = [s("mute:a@x.com", "2026-07-10T00:00:00Z")];
    const { merged } = mergeSuggestions(existing, fresh);
    expect(merged[0].createdAt).toBe("2026-06-01T00:00:00Z");
  });

  test("drops dismissed + applied ids from both sides", () => {
    const existing = [s("mute:a@x.com"), s("vip:c@x.com")];
    const fresh = [s("vip:b@x.com")];
    const { merged, added } = mergeSuggestions(
      existing,
      fresh,
      ["mute:a@x.com"],
      ["vip:c@x.com"],
    );
    expect(merged.map((m) => m.id)).toEqual(["vip:b@x.com"]);
    expect(added.map((a) => a.id)).toEqual(["vip:b@x.com"]);
  });
});
