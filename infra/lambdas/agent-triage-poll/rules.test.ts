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
  type KeywordRule,
  describeKeywordRule,
  isWellFormedKeywordRule,
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

const defineWildcardMatchSuite1 = () => {
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
};

describe("wildcardMatch", defineWildcardMatchSuite1);

const defineApplyRulesSuite2 = () => {
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
};

describe("applyRules", defineApplyRulesSuite2);

const base: EscalationConfig = {
    senders: [],
    keywords: [],
    labelTriggers: ["important"],
  };
function esc(
    label: Parameters<typeof shouldEscalate>[0]["label"],
    features = makeFeatures(),
    escalation: EscalationConfig = base,
    extra: Partial<Parameters<typeof shouldEscalate>[0]> = {},
  ) {
    return shouldEscalate({
      label,
      source: "llm",
      confidence: 1,
      features,
      escalation,
      ...extra,
    });
  }

function defineShouldEscalateSuite3Part1() {


  // Convenience wrapper — most tests exercise the legacy `all` mode with an
  // LLM-source `important` at confidence 1.


  describe("mode: all (default, legacy behaviour)", () => {
    test("non-important labels never escalate", () => {
      expect(esc("later")).toEqual({ escalate: false });
      expect(esc("news")).toEqual({ escalate: false });
    });

    test("important + empty sender/keyword lists → escalate (label-only trigger)", () => {
      expect(esc("important")).toMatchObject({
        escalate: true,
        reason: "label:important",
      });
    });

    test("important + sender in escalation list → escalate", () => {
      const r = esc(
        "important",
        makeFeatures({ fromEmail: "ceo@psd401.net" }),
        { ...base, senders: ["ceo@psd401.net"] },
      );
      expect(r).toMatchObject({ escalate: true, reason: "sender:ceo@psd401.net" });
    });

    test("important + sender NOT in list (list non-empty) → no escalate", () => {
      const r = esc(
        "important",
        makeFeatures({ fromEmail: "intern@psd401.net" }),
        { ...base, senders: ["ceo@psd401.net"] },
      );
      expect(r).toEqual({ escalate: false });
    });

    test("important + subject contains escalation keyword → escalate", () => {
      const r = esc(
        "important",
        makeFeatures({ subjectLower: "p0: outage" }),
        { ...base, keywords: ["p0"] },
      );
      expect(r).toMatchObject({ escalate: true, reason: "keyword:p0" });
    });

    test("important label not in labelTriggers → no escalate", () => {
      const r = esc("important", makeFeatures(), { ...base, labelTriggers: [] });
      expect(r).toEqual({ escalate: false });
    });

    test("explicit mode 'all' matches the default", () => {
      expect(esc("important", makeFeatures(), base, { mode: "all" })).toMatchObject({
        escalate: true,
        reason: "label:important",
      });
    });
  });

  describe("mode: none", () => {
    test("never escalates, even a rule-source important", () => {
      expect(
        shouldEscalate({
          label: "important",
          source: "rule",
          confidence: 1,
          features: makeFeatures(),
          escalation: base,
          mode: "none",
        }),
      ).toEqual({ escalate: false });
    });

    test("does not escalate even for an explicit escalation sender", () => {
      expect(
        esc(
          "important",
          makeFeatures({ fromEmail: "ceo@psd401.net" }),
          { ...base, senders: ["ceo@psd401.net"] },
          { mode: "none" },
        ),
      ).toEqual({ escalate: false });
    });
  });

  describe("mode: rules-only", () => {
    test("rule-source important escalates", () => {
      expect(
        shouldEscalate({
          label: "important",
          source: "rule",
          confidence: 1,
          features: makeFeatures(),
          escalation: base,
          mode: "rules-only",
        }),
      ).toMatchObject({ escalate: true, reason: "rule:important" });
    });

    test("plain LLM important never pings (even at confidence 1)", () => {
      expect(esc("important", makeFeatures(), base, { mode: "rules-only" })).toEqual({
        escalate: false,
      });
    });

    test("explicit escalation sender still pings", () => {
      const r = esc(
        "important",
        makeFeatures({ fromEmail: "ceo@psd401.net" }),
        { ...base, senders: ["ceo@psd401.net"] },
        { mode: "rules-only" },
      );
      expect(r).toMatchObject({ escalate: true, reason: "sender:ceo@psd401.net" });
    });
  });

  }

function defineShouldEscalateSuite3Part2() {describe("mode: high-confidence", () => {
    test("rule-source always pings", () => {
      expect(
        shouldEscalate({
          label: "important",
          source: "rule",
          confidence: 1,
          features: makeFeatures(),
          escalation: base,
          mode: "high-confidence",
        }),
      ).toMatchObject({ escalate: true, reason: "rule:important" });
    });

    test("LLM at the default threshold (0.85) pings", () => {
      expect(
        esc("important", makeFeatures(), base, {
          mode: "high-confidence",
          confidence: 0.85,
        }),
      ).toMatchObject({ escalate: true });
    });

    test("LLM just below the default threshold does NOT ping", () => {
      expect(
        esc("important", makeFeatures(), base, {
          mode: "high-confidence",
          confidence: 0.84,
        }),
      ).toEqual({ escalate: false });
    });

    test("a content-stage hit never clears the bar, however high (#1861)", () => {
      // The content stage stamps a FIXED confidence on every hit, so before
      // #1861 one heuristic match — a question mark in a marketing footer —
      // read as 0.9 and pinged Chat. `high-confidence` is documented as
      // "rule matches and LLM decisions", and now behaves that way.
      for (const confidence of [0.7, 0.85, 0.9, 1]) {
        expect([
          confidence,
          esc("important", makeFeatures(), base, {
            mode: "high-confidence",
            source: "content",
            confidence,
          }),
        ]).toEqual([confidence, { escalate: false }]);
      }
    });

    test("an explicit escalation rule still pings a content-stage hit (#1861)", () => {
      // The veto is on the MODE's confidence bar, not on the user's own
      // "always tell me about this sender" instruction.
      expect(
        esc(
          "important",
          makeFeatures({ fromEmail: "boss@psd401.net" }),
          { senders: ["boss@psd401.net"], keywords: [], labelTriggers: ["important"] },
          { mode: "high-confidence", source: "content", confidence: 0.7 },
        ),
      ).toMatchObject({ escalate: true, reason: "sender:boss@psd401.net" });
    });

    test("custom threshold boundary is honoured", () => {
      const below = esc("important", makeFeatures(), base, {
        mode: "high-confidence",
        confidence: 0.7,
        confidenceThreshold: 0.75,
      });
      expect(below).toEqual({ escalate: false });
      const atBar = esc("important", makeFeatures(), base, {
        mode: "high-confidence",
        confidence: 0.75,
        confidenceThreshold: 0.75,
      });
      expect(atBar).toMatchObject({ escalate: true });
    });
  });
}

const defineShouldEscalateSuite3 = () => {
  defineShouldEscalateSuite3Part1()
  defineShouldEscalateSuite3Part2()
};

describe("shouldEscalate", defineShouldEscalateSuite3);

// ---------------------------------------------------------------------
// Keyword-rule shape (#1855 items 1 and 5)
// ---------------------------------------------------------------------

describe("keyword rule well-formedness", () => {
  test("a boolean criterion is malformed, not a wildcard", () => {
    // `rules add-keyword x --from` used to persist `from_domain: true`.
    // It matched nothing, could not be deleted by value, and sat in the
    // classifier forever — #1855 item 1.
    const broken = {
      from_domain: true,
      label: "later",
    } as unknown as KeywordRule;
    expect(isWellFormedKeywordRule(broken)).toBe(false);
    expect(describeKeywordRule(broken)).toBe("malformed");
    expect(
      applyRules(makeFeatures(), { ...emptyRules, keywordRules: [broken] }),
    ).toEqual({ decided: false, reason: "no-rule-match" });
  });

  test("an external-only rule does not match everything external", () => {
    const rule = { external: true, label: "later" } as KeywordRule;
    expect(isWellFormedKeywordRule(rule)).toBe(false);
    expect(
      applyRules(makeFeatures({ isInternal: false }), {
        ...emptyRules,
        keywordRules: [rule],
      }),
    ).toEqual({ decided: false, reason: "no-rule-match" });
  });

  test("an empty-string criterion is malformed", () => {
    expect(
      isWellFormedKeywordRule({ subject_contains: "   ", label: "news" }),
    ).toBe(false);
  });

  test("an unknown label makes a rule malformed", () => {
    expect(
      isWellFormedKeywordRule({
        subject_contains: "x",
        label: "archive",
      } as unknown as KeywordRule),
    ).toBe(false);
  });
});

describe("keyword rule matching", () => {
  test("sender AND subject in one rule — both must hold", () => {
    const rule: KeywordRule = {
      id: "kw-1",
      from_address: "vendor@example.com",
      subject_contains: "invoice",
      label: "important",
    };
    const rules = { ...emptyRules, keywordRules: [rule] };
    expect(
      applyRules(
        makeFeatures({
          fromEmail: "vendor@example.com",
          subjectLower: "march invoice",
        }),
        rules,
      ),
    ).toMatchObject({ label: "important" });
    // Right sender, wrong subject.
    expect(
      applyRules(
        makeFeatures({ fromEmail: "vendor@example.com", subjectLower: "hello" }),
        rules,
      ),
    ).toEqual({ decided: false, reason: "no-rule-match" });
    // Right subject, wrong sender.
    expect(
      applyRules(
        makeFeatures({ fromEmail: "other@example.com", subjectLower: "march invoice" }),
        rules,
      ),
    ).toEqual({ decided: false, reason: "no-rule-match" });
  });

  test("subject_any is an OR across keywords", () => {
    const rules = {
      ...emptyRules,
      keywordRules: [
        { id: "kw-2", subject_any: ["invoice", "receipt", "statement"], label: "news" } as KeywordRule,
      ],
    };
    expect(applyRules(makeFeatures({ subjectLower: "your receipt" }), rules)).toMatchObject(
      { label: "news" },
    );
    expect(applyRules(makeFeatures({ subjectLower: "lunch?" }), rules)).toEqual({
      decided: false,
      reason: "no-rule-match",
    });
  });

  test("from_address is matched case-insensitively", () => {
    const rules = {
      ...emptyRules,
      keywordRules: [
        { from_address: "Vendor@Example.com", label: "news" } as KeywordRule,
      ],
    };
    expect(
      applyRules(makeFeatures({ fromEmail: "vendor@example.com" }), rules),
    ).toMatchObject({ label: "news" });
  });

  test("the reason names every criterion, so two rules are tellable apart", () => {
    expect(
      describeKeywordRule({
        from_domain: "example.com",
        subject_contains: "invoice",
        external: true,
        label: "later",
      }),
    ).toBe('from_domain=example.com + subject~"invoice" + external');
  });
});
