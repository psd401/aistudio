/**
 * Corrections must change behaviour (#1855 addendum 2, item 1).
 *
 * The reported failure: the account had 20 corrections, every one of them
 * "you said important, I archived it", and the classifier kept promoting
 * the same kind of mail. Corrections only ever became a soft prompt hint
 * keyed on the SENDER, so they could not generalise and nothing enforced
 * them.
 *
 * These tests are the before/after the issue asks for: the identical
 * model output, classified twice, differing only by whether the user's
 * corrections have been learned.
 *
 * Run: bun test content-learning.test.ts
 */
import { describe, expect, test } from "bun:test";

import { computeLearning } from "./learning";
import { applyContentGuards } from "./llm";
import { detectContentSignals } from "./content-features";
import type { CorrectionRecord, DecisionRecord, TriageRules } from "./types";

const NOW = Date.parse("2026-07-10T12:00:00Z");
const USER = "hagelk@psd401.net";
const emptyRules: TriageRules = {
  vipSenders: [],
  muteSenders: [],
  keywordRules: [],
};

/** A weekly status digest: the exact shape the user kept archiving. */
function statusDigestSignals(fromEmail: string) {
  return detectContentSignals({
    subject: "Weekly status report",
    body: "Here is this week's status update for the rollout.",
    headers: { to: USER },
    userEmail: USER,
    hasUserReply: false,
    fromEmail,
  });
}

function archivedDigest(
  messageId: string,
  fromEmail: string,
): { decision: DecisionRecord; correction: CorrectionRecord } {
  return {
    decision: {
      messageId,
      threadId: `t-${messageId}`,
      label: "important",
      source: "llm",
      reason: "looked urgent",
      confidence: 0.9,
      ts: "2026-07-09T00:00:00Z",
      fromEmail,
      subject: "Weekly status report",
      shape: "fyi",
      automatedSender: false,
    },
    correction: {
      messageId,
      fromLabel: "important",
      toLabel: "archived",
      ts: "2026-07-09T01:00:00Z",
      fromEmail,
      shape: "fyi",
      automatedSender: false,
    },
  };
}

describe("corrections change the next classification", () => {
  const modelSaidImportant = {
    label: "important" as const,
    confidence: 0.9,
    reason: "status report from a colleague",
  };

  test("BEFORE: with no corrections learned, the model's important stands", () => {
    const signals = statusDigestSignals("jsmith@psd401.net");
    const guarded = applyContentGuards(modelSaidImportant, signals, []);
    expect(guarded.label).toBe("important");
    expect(guarded.adjusted).toBe(false);
  });

  test("AFTER: two archives of that shape demote the same message to later", () => {
    const a = archivedDigest("m1", "jsmith@psd401.net");
    const b = archivedDigest("m2", "jsmith@psd401.net");
    const { contentPreferences } = computeLearning({
      corrections: [a.correction, b.correction],
      decisions: [a.decision, b.decision],
      rules: emptyRules,
      now: NOW,
    });
    expect(contentPreferences).toContainEqual(
      expect.objectContaining({ shape: "fyi", lean: "later", count: 2 }),
    );

    const signals = statusDigestSignals("jsmith@psd401.net");
    const guarded = applyContentGuards(
      modelSaidImportant,
      signals,
      contentPreferences,
    );
    expect(guarded.label).toBe("later");
    expect(guarded.adjusted).toBe(true);
    expect(guarded.reason).toContain("learned:you-archive-fyi-mail");
  });

  test("the lesson generalises to a sender who was never corrected", () => {
    // This is what a sender-keyed hint could not do, and is the reason
    // the user's 20 corrections changed nothing.
    const a = archivedDigest("m1", "jsmith@psd401.net");
    const b = archivedDigest("m2", "jsmith@psd401.net");
    const { contentPreferences } = computeLearning({
      corrections: [a.correction, b.correction],
      decisions: [a.decision, b.decision],
      rules: emptyRules,
      now: NOW,
    });
    const strangerSignals = statusDigestSignals("someone.new@psd401.net");
    expect(
      applyContentGuards(modelSaidImportant, strangerSignals, contentPreferences)
        .label,
    ).toBe("later");
  });

  test("a learned demotion never overrides a real ask", () => {
    // The guard must not swallow "please approve by Friday" just because
    // the user archives status reports.
    const a = archivedDigest("m1", "jsmith@psd401.net");
    const b = archivedDigest("m2", "jsmith@psd401.net");
    const { contentPreferences } = computeLearning({
      corrections: [a.correction, b.correction],
      decisions: [a.decision, b.decision],
      rules: emptyRules,
      now: NOW,
    });
    const askSignals = detectContentSignals({
      subject: "Weekly status report",
      body: "Status attached — can you confirm the headcount by Friday?",
      headers: { to: USER },
      userEmail: USER,
      hasUserReply: false,
      fromEmail: "jsmith@psd401.net",
    });
    expect(
      applyContentGuards(modelSaidImportant, askSignals, contentPreferences)
        .label,
    ).toBe("important");
  });

  test("one correction is not enough to change behaviour", () => {
    const a = archivedDigest("m1", "jsmith@psd401.net");
    const { contentPreferences } = computeLearning({
      corrections: [a.correction],
      decisions: [a.decision],
      rules: emptyRules,
      now: NOW,
    });
    expect(
      applyContentGuards(
        modelSaidImportant,
        statusDigestSignals("jsmith@psd401.net"),
        contentPreferences,
      ).label,
    ).toBe("important");
  });
});

describe("people are never filed as news", () => {
  test("a model 'news' on a human sender becomes later", () => {
    const signals = statusDigestSignals("jsmith@psd401.net");
    expect(signals.automatedSender).toBe(false);
    const guarded = applyContentGuards(
      { label: "news", confidence: 0.95, reason: "looks like a newsletter" },
      signals,
      [],
    );
    expect(guarded.label).toBe("later");
    expect(guarded.reason).toContain("human-sender-never-news");
  });

  test("a real newsletter from a machine stays news", () => {
    const signals = detectContentSignals({
      subject: "The Monday Briefing",
      body: "This week in ed-tech.",
      headers: { listUnsubscribe: "<mailto:unsub@news.example>" },
      userEmail: USER,
      hasUserReply: false,
      fromEmail: "briefing@news.example",
    });
    const guarded = applyContentGuards(
      { label: "news", confidence: 0.95, reason: "newsletter" },
      signals,
      [],
    );
    expect(guarded.label).toBe("news");
    expect(guarded.adjusted).toBe(false);
  });
});
