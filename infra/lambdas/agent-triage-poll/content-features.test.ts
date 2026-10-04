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
  firedContentSignals,
  hasAsk,
  hasDirectQuestion,
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

  test("approval is a request construction, not a bare noun (PR #1856 review)", () => {
    for (const text of [
      "Please approve the attached PO",
      "This needs your approval by Friday",
      "Requires your signature",
      "Submitted for approval: travel request",
      "Awaiting your sign-off",
      "Can you sign off on the budget?",
    ]) {
      expect([text, signalsFor({ subject: text }).approvalRequest]).toEqual([text, true]);
    }
    for (const text of [
      "FYI: the new approval workflow is live",
      "Approval is not required for this change",
      "No approval needed — already processed",
      "This does not require your signature",
      "Authorization policy update",
      "Approver list for 2026-27",
      "Update your email signature",
    ]) {
      expect([text, signalsFor({ subject: text }).approvalRequest]).toEqual([text, false]);
    }
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

/**
 * #1861. A Google Search Console blast scored `important` 0.9 and pinged
 * Chat because `directQuestion` was `text.includes("?")` and the marketing
 * line "Think this is awesome? Go ahead and …" contains one — and because
 * `automatedSender` was detected but did not veto the content stage.
 */
describe("directQuestion requires a question put to the reader (#1861)", () => {
  test("a rhetorical marketing question is not a question to the reader", () => {
    for (const text of [
      "Think this is awesome?",
      "Think this is awesome? Go ahead and share it.",
      "Why does this matter?",
      "Ready for the next release?",
      "Want to see more?",
      "?",
    ]) {
      expect([text, hasDirectQuestion(text)]).toEqual([text, false]);
    }
  });

  test("a second-person question still counts", () => {
    for (const text of [
      "Can you confirm the budget line for this?",
      "Would you mind reviewing this?",
      "Any update on your section?",
      "Is this yours?",
      "Are you available Thursday?",
    ]) {
      expect([text, hasDirectQuestion(text)]).toEqual([text, true]);
    }
  });

  test("only the clause the question mark terminates is considered", () => {
    // "your" sits in the NEXT sentence, so it must not rescue the
    // rhetorical question before it.
    expect(hasDirectQuestion("Think this is awesome? Go ahead and share your success.")).toBe(
      false,
    );
    // ...and a second-person question later in the text still counts.
    expect(hasDirectQuestion("Big news! Can you join us?")).toBe(true);
  });

  test("a hard-wrapped question still counts", () => {
    // A single newline in a plain-text or forwarded body is where the mail
    // client wrapped the line, NOT a sentence boundary. Treating it as one
    // tested only the text after the wrap and lost the "you" above it —
    // the exact mechanism #1861 added, failing on real mail.
    for (const text of [
      "Could you confirm\nthe budget by Friday?",
      "Can you please take a look at\nthe attached revision?",
      "I wanted to ask whether you had\nany thoughts on the vendor?",
    ]) {
      expect([text, hasDirectQuestion(text)]).toEqual([text, true]);
    }
  });

  test("a dot inside a token does not end a clause", () => {
    // A version, a hostname, a decimal or a URL carries a `.` that is not
    // a sentence boundary. Resetting the clause there swallowed the
    // second-person reference sitting before it, so a real question to the
    // user silently lost its deterministic `important`.
    for (const text of [
      "What do you think of v1.2?",
      "What do you think of example.com?",
      "Can you review https://psd401.net/doc?",
      "Did you see the 3.5 GPA report?",
    ]) {
      expect([text, hasDirectQuestion(text)]).toEqual([text, true]);
    }
  });

  test("a real sentence-ending dot still ends the clause", () => {
    // The counter-direction: the dotted-token exemption must not let a
    // second-person word reach a rhetorical question in the next sentence.
    for (const text of [
      "Your site is noticed. Think this is awesome?",
      "We updated v1.2 for your site. Think this is awesome?",
      "Nope. Not for you. Right?",
    ]) {
      expect([text, hasDirectQuestion(text)]).toEqual([text, false]);
    }
  });

  test("a blank line DOES end a thought", () => {
    // ...so flattening wraps must not let a second-person word reach a
    // rhetorical question in the next paragraph.
    expect(hasDirectQuestion("Thanks for your time.\n\nThink this is awesome?")).toBe(
      false,
    );
    expect(hasDirectQuestion("Your report is attached\n\nThink this is awesome?")).toBe(
      false,
    );
  });

  test("the subject does not bleed into the body's first question", () => {
    // The seam has to stay a hard boundary now that a newline is not one.
    // A subject with no terminal punctuation would otherwise lend its
    // "Your" to the body's rhetorical opener.
    const signals = signalsFor({
      fromEmail: "jsmith@psd401.net",
      subject: "Your weekly report",
      body: "Think this is awesome?",
      headers: { to: USER },
    });
    expect(signals.directQuestion).toBe(false);
  });

  test("a question in the subject alone still counts", () => {
    expect(
      signalsFor({ subject: "Can you join Thursday?", headers: { to: USER } })
        .directQuestion,
    ).toBe(true);
  });

  test("contractions need no special case — straight or curly apostrophe", () => {
    // `\byou\b` matches across an apostrophe because the apostrophe is a
    // non-word character. A dedicated `you'(?:re|ll|ve|d)` alternative was
    // dead code and was removed; this pins why that is safe.
    for (const text of [
      "you're on it, right?",
      "you’re on it, right?",
      "you'll review this?",
      "you’ve seen this?",
    ]) {
      expect([text, hasDirectQuestion(text)]).toEqual([text, true]);
    }
  });

  test("stays linear on a hostile subject", () => {
    // The first implementation used `/[^.!?\n]*\?/g`, which is quadratic on
    // text containing no question mark — the star consumes to the end,
    // fails, backtracks, and repeats from the next start position. Measured
    // at 2.5s for 64KB, rising 16x per 4x of length. The text is
    // attacker-controlled (any sender's subject, which OPENING_TEXT_CHARS
    // does not bound), so this was a Lambda DoS. The bound below is loose
    // on purpose: the linear scan does 1MB in ~2ms, the regex took minutes.
    const hostile = "a".repeat(1_000_000);
    const started = Date.now();
    expect(hasDirectQuestion(hostile)).toBe(false);
    expect(hasDirectQuestion(`${hostile}?`)).toBe(false);
    expect(hasDirectQuestion(`can you? ${hostile}`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("the reported Google Search Console blast classifies later", () => {
    const signals = signalsFor({
      fromEmail: "sc-noreply@google.com",
      subject: "Congrats on reaching 50 clicks in 28 days!",
      body:
        "Your site is getting noticed in Google Search. " +
        "Think this is awesome? Go ahead and ",
      headers: { to: USER, listUnsubscribe: "<mailto:unsub@google.com>" },
    });
    expect(signals.directQuestion).toBe(false);
    expect(signals.automatedSender).toBe(true);
    expect(signals.informational).toBe(true);
    expect(hasAsk(signals)).toBe(false);
    expect(classifyByContent(signals)).toEqual({
      label: "later",
      reason: "content:automated-notice-no-ask",
    });
    // The acceptance criterion: simulate can name the signals that fired.
    expect(firedContentSignals(signals)).toEqual([
      "addressedToUser",
      "broadcast",
      "informational",
      "automatedSender",
    ]);
  });
});

describe("an automated sender cannot buy `important` with a soft ask (#1861)", () => {
  test("a second-person question from a noreply mailbox does not decide", () => {
    // Nobody is waiting on a reply to a noreply address, so this falls
    // through to the model (which still sees every signal) rather than
    // being stamped `important` by one regex hit.
    const signals = signalsFor({
      fromEmail: "sc-noreply@google.com",
      subject: "Want to see your top queries?",
      body: "Can you spare two minutes to tell us what you think?",
      headers: { to: USER },
    });
    expect(signals.directQuestion).toBe(true);
    expect(signals.automatedSender).toBe(true);
    expect(classifyByContent(signals)).toBeNull();
  });

  test("the identical message from a colleague IS important", () => {
    // The veto is on the sender CLASS, not a sender identity — the same
    // words from a person still land `important`.
    const signals = signalsFor({
      fromEmail: "jsmith@psd401.net",
      subject: "Want to see your top queries?",
      body: "Can you spare two minutes to tell us what you think?",
      headers: { to: USER },
    });
    expect(classifyByContent(signals)).toEqual({
      label: "important",
      reason: "content:direct-question-addressed-to-you",
    });
  });

  test("an approval request from a machine is still exempt from the veto", () => {
    const signals = signalsFor({
      fromEmail: "noreply@servicedesk.example",
      subject: "Approval required: purchase order 4471",
      body: "A request is pending your approval. Can you action it?",
      headers: { to: USER },
    });
    expect(signals.automatedSender).toBe(true);
    expect(classifyByContent(signals)).toEqual({
      label: "important",
      reason: "content:approval-or-signature-requested",
    });
  });
});

describe("bulk-mail boilerplate marks informational (#1861 item 4)", () => {
  test("List-Unsubscribe alone is enough", () => {
    const signals = signalsFor({
      fromEmail: "news@vendor.com",
      subject: "Spring product roundup",
      body: "Here is what shipped this quarter.",
      headers: { to: USER, listUnsubscribe: "<mailto:unsub@vendor.com>" },
    });
    expect(signals.informational).toBe(true);
  });

  test("marketing footer phrases count — but only from an automated sender", () => {
    const text = "Go ahead and tell a friend. You are receiving this because you signed up.";
    expect(
      signalsFor({ fromEmail: "promo-noreply@vendor.com", body: text }).informational,
    ).toBe(true);
    // "Go ahead and" is ordinary English from a colleague and must not
    // turn their mail into an FYI.
    expect(
      signalsFor({
        fromEmail: "jsmith@psd401.net",
        subject: "Budget",
        body: "Go ahead and send it whenever you get a chance.",
        headers: { to: USER },
      }).informational,
    ).toBe(false);
  });
});

describe("firedContentSignals (#1861 acceptance)", () => {
  test("names only the true signals, in the order the stage consults them", () => {
    const signals = signalsFor({
      fromEmail: "jsmith@psd401.net",
      subject: "Board packet",
      body: "Please send your section by EOD Friday.",
      headers: { to: USER },
    });
    expect(firedContentSignals(signals)).toEqual([
      "actionRequest",
      "deadline",
      "addressedToUser",
    ]);
  });

  test("an empty signal set is an empty list, not a throw", () => {
    expect(firedContentSignals(signalsFor())).toEqual([]);
  });
});

describe("sender-independence regression pair (#1861 comment)", () => {
  // The reported pair: an "Important notice about your AWS Account
  // regarding VPN connections" scored important 0.9 (reason
  // "internal-AWS-account-notice") from an internal relay and later 0.6
  // from health@aws.com. Identical content must produce identical
  // deterministic output — the content stage may not read the sender's
  // identity, only its CLASS.
  const subject =
    "Important notice about your AWS Account regarding VPN connections";
  const body =
    "We are reaching out because your account has VPN connections that " +
    "will be affected by an upcoming change.";

  test("the same notice from an internal relay and from aws.com agrees", () => {
    const internal = signalsFor({
      fromEmail: "aws-notices@psd401.net",
      subject,
      body,
      headers: { to: USER },
    });
    const external = signalsFor({
      fromEmail: "health@aws.com",
      subject,
      body,
      headers: { to: USER },
    });
    expect(internal).toEqual(external);
    expect(firedContentSignals(internal)).toEqual(firedContentSignals(external));
    expect(classifyByContent(internal)).toEqual(classifyByContent(external));
  });

  test("...and still agrees once the sender IS an automated mailbox", () => {
    // `automatedSender` is a sender CLASS, so both sides move together
    // when both addresses are machine mailboxes.
    const internal = signalsFor({
      fromEmail: "serv_awsrelay@psd401.net",
      subject,
      body,
      headers: { to: USER },
    });
    const external = signalsFor({
      fromEmail: "no-reply@aws.com",
      subject,
      body,
      headers: { to: USER },
    });
    expect(classifyByContent(internal)).toEqual(classifyByContent(external));
    expect(classifyByContent(internal)?.label).toBe("later");
  });
});
