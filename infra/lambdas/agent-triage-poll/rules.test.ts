/**
 * Unit tests for the deterministic rule engine.
 *
 * Run: bun test rules.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  applyRules,
  shouldEscalate,
  wildcardMatch,
  type EmailFeatures,
  type TriageRules,
  type EscalationConfig,
} from "./rules";

function makeFeatures(overrides: Partial<EmailFeatures> = {}): EmailFeatures {
  return {
    fromEmail: "alice@psd401.net",
    fromDomain: "psd401.net",
    isInternal: true,
    subject: "Hi",
    subjectLower: "hi",
    snippetLower: "just checking in",
    hasUserReply: false,
    ...overrides,
  };
}

const emptyRules: TriageRules = {
  vipSenders: [],
  muteSenders: [],
  keywordRules: [],
};

describe("wildcardMatch", () => {
  test("exact match", () => {
    expect(wildcardMatch("hi@example.com", "hi@example.com")).toBe(true);
  });
  test("case insensitive", () => {
    expect(wildcardMatch("Hi@Example.com", "hi@example.com")).toBe(true);
  });
  test("prefix wildcard", () => {
    expect(wildcardMatch("noreply@*", "noreply@github.com")).toBe(true);
    expect(wildcardMatch("noreply@*", "kris@github.com")).toBe(false);
  });
  test("suffix wildcard", () => {
    expect(wildcardMatch("*.psd401.net", "mail.psd401.net")).toBe(true);
    expect(wildcardMatch("*.psd401.net", "psd401.net")).toBe(false);
  });
  test("middle wildcard", () => {
    expect(wildcardMatch("alerts*@datadog.com", "alerts-noreply@datadog.com")).toBe(true);
  });
  test("empty inputs are false", () => {
    expect(wildcardMatch("", "a")).toBe(false);
    expect(wildcardMatch("a", "")).toBe(false);
  });
});

describe("applyRules", () => {
  test("undecided when no rules match", () => {
    const r = applyRules(makeFeatures(), emptyRules);
    expect(r).toEqual({ decided: false, reason: "no-rule-match" });
  });

  test("vip sender → important", () => {
    const r = applyRules(
      makeFeatures({ fromEmail: "ceo@psd401.net" }),
      { ...emptyRules, vipSenders: ["ceo@psd401.net"] },
    );
    expect(r).toMatchObject({ label: "important", source: "rule" });
  });

  test("mute sender → later (wildcard)", () => {
    const r = applyRules(
      makeFeatures({ fromEmail: "noreply@github.com", fromDomain: "github.com" }),
      { ...emptyRules, muteSenders: ["noreply@*"] },
    );
    expect(r).toMatchObject({ label: "later", source: "rule" });
  });

  test("vip beats mute when sender appears in both", () => {
    const r = applyRules(
      makeFeatures({ fromEmail: "ceo@psd401.net" }),
      {
        ...emptyRules,
        vipSenders: ["ceo@psd401.net"],
        muteSenders: ["*@psd401.net"],
      },
    );
    expect(r).toMatchObject({ label: "important" });
  });

  test("user-replied thread → important (no other rule needed)", () => {
    const r = applyRules(
      makeFeatures({ hasUserReply: true }),
      emptyRules,
    );
    expect(r).toMatchObject({ label: "important", reason: "thread:user-replied-here" });
  });

  test("user-replied thread loses to mute (we still hide noise)", () => {
    const r = applyRules(
      makeFeatures({
        fromEmail: "noreply@github.com",
        fromDomain: "github.com",
        hasUserReply: true,
      }),
      { ...emptyRules, muteSenders: ["noreply@*"] },
    );
    expect(r).toMatchObject({ label: "later" });
  });

  test("keyword rule: subject contains 'newsletter' → news", () => {
    const r = applyRules(
      makeFeatures({ subject: "Daily Newsletter", subjectLower: "daily newsletter" }),
      {
        ...emptyRules,
        keywordRules: [{ subject_contains: "newsletter", label: "news" }],
      },
    );
    expect(r).toMatchObject({ label: "news" });
  });

  test("external+keyword: external sender with 'urgent' → later", () => {
    const r = applyRules(
      makeFeatures({
        fromEmail: "blast@spammy.co",
        fromDomain: "spammy.co",
        isInternal: false,
        subjectLower: "urgent: act now",
      }),
      {
        ...emptyRules,
        keywordRules: [
          {
            subject_contains: "urgent",
            external: true,
            label: "later",
          },
        ],
      },
    );
    expect(r).toMatchObject({ label: "later" });
  });

  test("rule with only `external` (no positive criterion) does NOT match", () => {
    const r = applyRules(
      makeFeatures({ isInternal: false }),
      {
        ...emptyRules,
        keywordRules: [{ external: true, label: "later" }],
      },
    );
    expect(r).toEqual({ decided: false, reason: "no-rule-match" });
  });

  test("first matching keyword rule wins", () => {
    const r = applyRules(
      makeFeatures({ subjectLower: "newsletter — urgent action" }),
      {
        ...emptyRules,
        keywordRules: [
          { subject_contains: "newsletter", label: "news" },
          { subject_contains: "urgent", label: "later" },
        ],
      },
    );
    expect(r).toMatchObject({ label: "news" });
  });
});

describe("shouldEscalate", () => {
  const base: EscalationConfig = {
    senders: [],
    keywords: [],
    labelTriggers: ["important"],
  };

  test("non-important labels never escalate", () => {
    expect(shouldEscalate("later", makeFeatures(), base)).toEqual({ escalate: false });
    expect(shouldEscalate("news", makeFeatures(), base)).toEqual({ escalate: false });
  });

  test("important + empty sender/keyword lists → escalate (label-only trigger)", () => {
    const r = shouldEscalate("important", makeFeatures(), base);
    expect(r).toMatchObject({ escalate: true, reason: "label:important" });
  });

  test("important + sender in escalation list → escalate", () => {
    const r = shouldEscalate(
      "important",
      makeFeatures({ fromEmail: "ceo@psd401.net" }),
      { ...base, senders: ["ceo@psd401.net"] },
    );
    expect(r).toMatchObject({ escalate: true, reason: "sender:ceo@psd401.net" });
  });

  test("important + sender NOT in list (list non-empty) → no escalate", () => {
    const r = shouldEscalate(
      "important",
      makeFeatures({ fromEmail: "intern@psd401.net" }),
      { ...base, senders: ["ceo@psd401.net"] },
    );
    expect(r).toEqual({ escalate: false });
  });

  test("important + subject contains escalation keyword → escalate", () => {
    const r = shouldEscalate(
      "important",
      makeFeatures({ subjectLower: "p0: outage" }),
      { ...base, keywords: ["p0"] },
    );
    expect(r).toMatchObject({ escalate: true, reason: "keyword:p0" });
  });

  test("important label not in labelTriggers → no escalate", () => {
    const r = shouldEscalate("important", makeFeatures(), { ...base, labelTriggers: [] });
    expect(r).toEqual({ escalate: false });
  });
});
