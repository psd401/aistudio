/**
 * Content-feature tests (#1855).
 *
 * These pin the two acceptance criteria that the sender-driven classifier
 * could not meet:
 *   - two messages with the same content from different senders get the
 *     same label;
 *   - mail from a person is never treated as a machine blast.
 *
 * Run: bun test content-features.test.ts
 */
import { describe, expect, test } from "bun:test";

import {
  classifyByContent,
  detectContentSignals,
  hasAsk,
  isAutomatedSender,
  parseAddressList,
  type ContentSignalInput,
} from "./content-features";

const USER = "hagelk@psd401.net";

function signalsFor(over: Partial<ContentSignalInput> = {}) {
  return detectContentSignals({
    subject: "",
    body: "",
    headers: {},
    userEmail: USER,
    hasUserReply: false,
    fromEmail: "someone@psd401.net",
    ...over,
  });
}

describe("isAutomatedSender", () => {
  test("recognises the noreply family however it is spelled", () => {
    for (const address of [
      "noreply@vendor.com",
      "no-reply@vendor.com",
      "no_reply@vendor.com",
      "donotreply@vendor.com",
      "do-not-reply@vendor.com",
      "aws-marketing-no-reply@amazon.com",
      "mailer-daemon@psd401.net",
    ]) {
      expect(isAutomatedSender(address)).toBe(true);
    }
  });

  test("recognises PSD service-account naming", () => {
    // Named in #1855 as the local shapes that mark a machine mailbox.
    expect(isAutomatedSender("serv_powerschool@psd401.net")).toBe(true);
    expect(isAutomatedSender("tsd-sync@psd401.net")).toBe(true);
  });

  test("header evidence beats a human-looking address", () => {
    expect(
      isAutomatedSender("news@vendor.com", {
        listUnsubscribe: "<mailto:unsub@vendor.com>",
      }),
    ).toBe(true);
    expect(
      isAutomatedSender("someone@vendor.com", { autoSubmitted: "auto-generated" }),
    ).toBe(true);
    expect(isAutomatedSender("someone@vendor.com", { precedence: "bulk" })).toBe(
      true,
    );
  });

  test("Auto-Submitted: no is the explicit NOT-automated value", () => {
    expect(isAutomatedSender("a.person@psd401.net", { autoSubmitted: "no" })).toBe(
      false,
    );
  });

  test("a colleague is a person", () => {
    // The whole point of #1855 item 3: these addresses must never become
    // mute candidates.
    for (const address of [
      "jsmith@psd401.net",
      "dave.stitt@psd401.net",
      "health@aws.com",
    ]) {
      expect(isAutomatedSender(address)).toBe(false);
    }
  });
});

describe("parseAddressList", () => {
  test("pulls addresses out of display-name syntax", () => {
    expect(
      parseAddressList('"Hagel, Kris" <Hagelk@psd401.net>, jo@x.org'),
    ).toEqual(["hagelk@psd401.net", "jo@x.org"]);
  });

  test("an absent header is an empty list, not a throw", () => {
    expect(parseAddressList(undefined)).toEqual([]);
  });
});

describe("detectContentSignals", () => {
  test("recipient role comes from the headers", () => {
    const addressed = signalsFor({ headers: { to: USER, cc: "other@psd401.net" } });
    expect(addressed.addressedToUser).toBe(true);
    expect(addressed.ccOnly).toBe(false);

    const copied = signalsFor({ headers: { to: "other@psd401.net", cc: USER } });
    expect(copied.addressedToUser).toBe(false);
    expect(copied.ccOnly).toBe(true);
  });

  test("a question late in a long body is not an opening-text question", () => {
    const signals = signalsFor({
      subject: "Monthly report",
      body: `${"filler text. ".repeat(80)}any questions?`,
    });
    expect(signals.directQuestion).toBe(false);
  });

  test("an approval request is detected from the subject alone", () => {
    const signals = signalsFor({ subject: "Approval needed: travel request" });
    expect(signals.approvalRequest).toBe(true);
    expect(signals.shape).toBe("approval");
  });

  test("a live thread needs BOTH a reply from the user and thread headers", () => {
    expect(
      signalsFor({ subject: "Re: budget", hasUserReply: true }).liveThread,
    ).toBe(true);
    expect(
      signalsFor({ subject: "Re: budget", hasUserReply: false }).liveThread,
    ).toBe(false);
    expect(
      signalsFor({ subject: "budget", hasUserReply: true }).liveThread,
    ).toBe(false);
  });

  test("hasAsk is false for a pure status report", () => {
    const signals = signalsFor({
      subject: "Weekly digest",
      body: "FYI, here is the weekly summary. No action required.",
    });
    expect(hasAsk(signals)).toBe(false);
    expect(signals.informational).toBe(true);
  });
});

describe("classifyByContent", () => {
  test("THE acceptance criterion: same content, different senders, same label", () => {
    // #1855 item 4 reported the same AWS health notice scoring important
    // 0.9 from an internal relay and later 0.6 from health@aws.com.
    const body =
      "Your AWS account has a scheduled maintenance event. No action required.";
    const internal = signalsFor({
      fromEmail: "aws-notices@psd401.net",
      subject: "AWS account notice",
      body,
      headers: { to: USER },
    });
    const external = signalsFor({
      fromEmail: "health@aws.com",
      subject: "AWS account notice",
      body,
      headers: { to: USER },
    });
    expect(classifyByContent(internal)).toEqual(classifyByContent(external));
    expect(classifyByContent(internal)?.label).toBe("later");
  });

  test("an approval request is important even from a machine", () => {
    const signals = signalsFor({
      fromEmail: "noreply@servicedesk.example",
      subject: "Approval required: purchase order 4471",
      body: "A request is pending your approval.",
    });
    expect(signals.automatedSender).toBe(true);
    expect(classifyByContent(signals)).toEqual({
      label: "important",
      reason: "content:approval-or-signature-requested",
    });
  });

  test("a direct question addressed to the user is important", () => {
    const signals = signalsFor({
      subject: "Chromebook refresh",
      body: "Can you confirm the budget line for this?",
      headers: { to: USER },
    });
    expect(classifyByContent(signals)).toEqual({
      label: "important",
      reason: "content:direct-question-addressed-to-you",
    });
  });

  test("the same question with the user only on Cc is left to the model", () => {
    // Being copied on someone else's question is the 31%-reply case in the
    // behaviour analysis; it is not automatically important, but nor is it
    // automatically later, so the content stage declines to decide.
    const signals = signalsFor({
      subject: "Chromebook refresh",
      body: "Can you confirm the budget line for this?",
      headers: { to: "someone.else@psd401.net", cc: USER },
    });
    expect(classifyByContent(signals)).toBeNull();
  });

  test("an automated notice that asks nothing is later", () => {
    const signals = signalsFor({
      fromEmail: "noreply@github.com",
      subject: "Build #4471 succeeded",
      body: "The build completed.",
    });
    expect(classifyByContent(signals)?.label).toBe("later");
  });

  test("an FYI from a colleague is later, not news", () => {
    const signals = signalsFor({
      fromEmail: "jsmith@psd401.net",
      subject: "FYI — enrollment numbers",
      body: "FYI, attaching the October counts. No action needed.",
      headers: { to: USER },
    });
    const decision = classifyByContent(signals);
    expect(decision?.label).toBe("later");
    expect(signals.automatedSender).toBe(false);
  });

  test("a deadline from a colleague is NOT auto-demoted", () => {
    const signals = signalsFor({
      fromEmail: "jsmith@psd401.net",
      subject: "Board packet",
      body: "Please send your section by EOD Friday.",
      headers: { to: USER },
    });
    expect(hasAsk(signals)).toBe(true);
    expect(classifyByContent(signals)?.label).toBe("important");
  });

  test("ambiguous human mail falls through to the model", () => {
    const signals = signalsFor({
      fromEmail: "jsmith@psd401.net",
      subject: "Thoughts on the vendor demo",
      body: "That demo went about how I expected.",
      headers: { to: USER },
    });
    expect(classifyByContent(signals)).toBeNull();
  });
});
