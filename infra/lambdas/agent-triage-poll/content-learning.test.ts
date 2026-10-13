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
import { applyContentGuards, finalizeLLMLabel } from "./llm";
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
    expect(guarded.reason).toContain("learned:you-file-fyi-mail-as-later");
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

describe("corrections to News generalise by shape (#1866)", () => {
  /** A digest the stage files as `bulk`. */
  function digestSignals(fromEmail: string) {
    return detectContentSignals({
      subject: "Daily Highlights",
      body: "Today's top stories from the member network.",
      headers: { to: USER, listUnsubscribe: "<mailto:u@x.example>" },
      userEmail: USER,
      hasUserReply: false,
      fromEmail,
    });
  }

  function relabelledToNews(
    messageId: string,
    fromEmail: string,
  ): { decision: DecisionRecord; correction: CorrectionRecord } {
    return {
      decision: {
        messageId,
        threadId: `t-${messageId}`,
        label: "later",
        source: "llm",
        reason: "FYI, no action required",
        confidence: 0.7,
        ts: "2026-07-09T00:00:00Z",
        fromEmail,
        subject: "Daily Highlights",
        shape: "bulk",
        automatedSender: true,
      },
      correction: {
        messageId,
        fromLabel: "later",
        toLabel: "news",
        ts: "2026-07-09T01:00:00Z",
        fromEmail,
        shape: "bulk",
        automatedSender: true,
      },
    };
  }

  const twoNewsCorrections = () => {
    const a = relabelledToNews("m1", "no-reply@mob.cosn.org");
    const b = relabelledToNews("m2", "no-reply@mob.iste.org");
    return computeLearning({
      corrections: [a.correction, b.correction],
      decisions: [a.decision, b.decision],
      rules: emptyRules,
      now: NOW,
    });
  };

  test("two `training correct <id> news` calls learn lean=news, not lean=later", () => {
    // Before this, `correctionLean` folded `news` into `later`, so the
    // one correction the user was actually making could never be learned.
    const { contentPreferences } = twoNewsCorrections();
    expect(contentPreferences).toContainEqual(
      expect.objectContaining({ shape: "bulk", lean: "news", count: 2 }),
    );
  });

  test("the learned leaning moves the model's `later` to news, for any sender", () => {
    const { contentPreferences } = twoNewsCorrections();
    const guarded = applyContentGuards(
      { label: "later", confidence: 0.8, reason: "FYI, no action required" },
      digestSignals("never-corrected@newsletter.example"),
      contentPreferences,
    );
    expect(guarded.label).toBe("news");
    expect(guarded.adjusted).toBe(true);
    expect(guarded.reason).toContain("learned:you-file-bulk-mail-as-news");
  });

  test("it never reaches a person's mail", () => {
    // A learned "this shape is News" must not file a colleague away in
    // the auto-archive bucket.
    const { contentPreferences } = twoNewsCorrections();
    const humanFyi = detectContentSignals({
      subject: "Daily Highlights",
      body: "Today's top stories from the member network.",
      headers: { to: USER },
      userEmail: USER,
      hasUserReply: false,
      fromEmail: "jsmith@psd401.net",
    });
    expect(humanFyi.automatedSender).toBe(false);
    expect(
      applyContentGuards(
        { label: "later", confidence: 0.8, reason: "colleague FYI" },
        humanFyi,
        contentPreferences,
      ).label,
    ).toBe("later");
  });

  test("corrections in both directions produce no leaning", () => {
    // The margin is over the runner-up, so a shape the user treats
    // inconsistently does not silently pick a side.
    const a = relabelledToNews("m1", "no-reply@mob.cosn.org");
    const b = relabelledToNews("m2", "no-reply@mob.iste.org");
    const rescued: CorrectionRecord[] = [
      { messageId: "m3", fromLabel: "later", toLabel: "inbox", ts: "2026-07-09T01:00:00Z", shape: "bulk", fromEmail: "x@y.example" },
      { messageId: "m4", fromLabel: "later", toLabel: "important", ts: "2026-07-09T01:00:00Z", shape: "bulk", fromEmail: "x@y.example" },
    ];
    const { contentPreferences } = computeLearning({
      corrections: [a.correction, b.correction, ...rescued],
      decisions: [a.decision, b.decision],
      rules: emptyRules,
      now: NOW,
    });
    expect(contentPreferences.find((p) => p.shape === "bulk")).toBeUndefined();
  });
});

describe("a declared list mailing the model calls Later is News (#1866)", () => {
  // The content stage cannot reach a bulk publication that carries an
  // ask, so the model decides it. Its own `later` becomes News; a `later`
  // forced by a confidence floor or the Bedrock fail-safe does not.
  const registrationBlast = detectContentSignals({
    subject: "Last chance to register for the fall conference",
    body: "Register by Friday to keep your member rate.",
    headers: { to: USER, listUnsubscribe: "<mailto:u@assoc.example>" },
    userEmail: USER,
    hasUserReply: false,
    fromEmail: "members@assoc.example",
  });

  test("the message really does carry an ask, so the model decides it", () => {
    expect(registrationBlast.deadline).toBe(true);
    expect(registrationBlast.bulkPublication).toBe(true);
  });

  test("a model `later` becomes news", () => {
    const guarded = applyContentGuards(
      { label: "later", confidence: 0.8, reason: "deadline but no ask of you" },
      registrationBlast,
      [],
    );
    expect(guarded.label).toBe("news");
    expect(guarded.adjusted).toBe(true);
    expect(guarded.reason).toContain("bulk-publication-not-later");
  });

  test("the Bedrock fail-safe stays later", () => {
    // finalizeLLMLabel downgrades the confidence-0 fail-safe; an outage
    // must not file a deadline-bearing message with the newsletters.
    const failSafe = finalizeLLMLabel({
      label: "later",
      confidence: 0,
      reason: "llm-error-default",
    });
    expect(applyContentGuards(failSafe, registrationBlast, []).label).toBe(
      "later",
    );
  });

  test("an under-confident `important` stays later, not news", () => {
    const floored = finalizeLLMLabel({
      label: "important",
      confidence: 0.7,
      reason: "asks you to register",
    });
    expect(floored.label).toBe("later");
    const guarded = applyContentGuards(floored, registrationBlast, []);
    expect(guarded.label).toBe("later");
    expect(guarded.adjusted).toBe(false);
  });

  test("a learned Later leaning is not overridden by the list guard", () => {
    // Guard 1 demotes an ask-less `important` to the user's own Later
    // leaning for this shape; guard 2b must not then flip it to News.
    const digest = detectContentSignals({
      subject: "Your weekly digest",
      body: "Here are this week's top stories.",
      headers: { to: USER, listUnsubscribe: "<mailto:u@news.example>" },
      userEmail: USER,
      hasUserReply: false,
      fromEmail: "digest@news.example",
    });
    expect(digest.shape).toBe("bulk");
    const guarded = applyContentGuards(
      { label: "important", confidence: 0.9, reason: "model" },
      digest,
      [{ shape: "bulk", lean: "later", weight: 5, count: 5 }],
    );
    expect(guarded.label).toBe("later");
  });

  test("an `important` from the model is left alone", () => {
    expect(
      applyContentGuards(
        { label: "important", confidence: 0.9, reason: "asks you to register" },
        registrationBlast,
        [],
      ).label,
    ).toBe("important");
  });
});
