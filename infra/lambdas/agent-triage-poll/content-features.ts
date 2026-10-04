/**
 * Content features for the triage classifier (#1855).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Before #1855 the classifier's only deterministic inputs were the
 * sender's address and domain. That produced the defect the issue
 * reports: the same AWS health notice scored `important` 0.9 when it
 * arrived through an internal relay and `later` 0.6 when it arrived from
 * `health@aws.com`. Identical content, different label, purely because of
 * who forwarded it.
 *
 * Everything in this module is derived from the MESSAGE — its headers'
 * recipient role, its thread position, and the words in its opening text.
 * `isAutomatedSender` is the one sender-derived signal, and it is a sender
 * *class* (does this address speak for a machine?) rather than a sender
 * *identity*; the issue explicitly asks for that distinction so mute
 * suggestions can be limited to automated senders.
 *
 * Pure and dependency-free so the whole decision surface is unit-testable
 * without Gmail or Bedrock.
 */

/**
 * The shape of an email, in terms of what it asks of the reader. This is
 * what corrections are learned against (#1855 addendum 2 item 1) — the
 * user archiving five FYI digests should teach "FYI digests are Later",
 * not "mute this colleague".
 */
export type ContentShape =
  | "approval"
  | "direct-ask"
  | "live-thread"
  | "notification"
  | "fyi"
  | "unknown";

/** Raw header values the signals are derived from. All optional. */
export interface MessageHeaders {
  to?: string;
  cc?: string;
  listUnsubscribe?: string;
  autoSubmitted?: string;
  precedence?: string;
  inReplyTo?: string;
  references?: string;
}

export interface ContentSignals {
  /** The opening text contains a question mark. */
  directQuestion: boolean;
  /** The text asks the reader to do something ("can you", "please review"). */
  actionRequest: boolean;
  /** The text asks for an approval / sign-off / authorization. */
  approvalRequest: boolean;
  /** The text names a deadline ("by Friday", "due", "no later than"). */
  deadline: boolean;
  /** The user's address appears in `To`. */
  addressedToUser: boolean;
  /** The user is only on `Cc` (or `Bcc`), never in `To`. */
  ccOnly: boolean;
  /** Bulk/list mail, or a large recipient fan-out. */
  broadcast: boolean;
  /** A reply in a thread the user has already participated in. */
  liveThread: boolean;
  /** FYI / status / digest language with nothing asked of the reader. */
  informational: boolean;
  /** The sender speaks for a machine rather than a person. */
  automatedSender: boolean;
  /** Derived summary used for learning and for the one-line reason. */
  shape: ContentShape;
}

export interface ContentSignalInput {
  subject: string;
  /** Body excerpt, or the Gmail snippet when no body could be fetched. */
  body: string;
  headers: MessageHeaders;
  /** The triage user's own address — decides To vs Cc-only. */
  userEmail: string;
  /** True when the user has a SENT message in the same thread. */
  hasUserReply: boolean;
  /** The sender's address, lowercased. */
  fromEmail: string;
}

/**
 * How much of the body counts as "opening text". The behaviour analysis in
 * #1855 measured the predictive signal on the opening of the message: a
 * question there predicted a reply 72% of the time versus 40% without one.
 * A question buried in a quoted footer carries no such signal.
 */
export const OPENING_TEXT_CHARS = 400;

const ACTION_RE =
  /\b(can you|could you|would you|will you|are you able|please (?:review|send|confirm|respond|reply|complete|fill|sign|update|look|advise|provide|share|let)|need (?:you|your)|needs your|let me know|your (?:thoughts|input|feedback|take)|action (?:required|needed)|requires? your|waiting on you|over to you|follow up with)\b/i;

const APPROVAL_RE =
  /\b(approve|authorize|authorise|sign[- ]?off on|please sign|pending your|awaiting your|ready for (?:your )?(?:review|signature)|(?:your|submitted for|sent for|routed for) (?:approval|authori[sz]ation|sign[- ]?off)|(?:needs?|requires?|requesting|request for|awaiting|pending) (?:your )?(?:approval|authori[sz]ation|sign[- ]?off|signature)|(?:approval|authori[sz]ation|sign[- ]?off|signature) (?:needed|required|requested))\b/i;

const DEADLINE_RE =
  /\b(by (?:eod|cob|end of day|close of business|tomorrow|today|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2})|due (?:by|on|date)|deadline|no later than|before the (?:end|close) of|asap|as soon as possible|expires? (?:on|in)|last chance to (?:respond|reply|submit))\b/i;

/**
 * Phrases that EXPLICITLY withdraw an ask. They are removed before the
 * ask patterns run, because "no action required" contains "action
 * required" and would otherwise be read as a request — turning the
 * clearest possible FYI into an `important`.
 */
const NEGATED_ASK_RE =
  /\bno (?:action|response|reply|rsvp|approval|authori[sz]ation|sign[- ]?off|signature) (?:is )?(?:needed|required|necessary)\b|\bnothing (?:is )?(?:needed|required)(?: from you)?\b|\bno need to (?:reply|respond|act|approve|sign)\b|\b(?:does not|doesn't|do not|don't|no longer) (?:need|require)s? (?:your )?(?:approval|authori[sz]ation|sign[- ]?off|signature)\b/gi;

const INFORMATIONAL_RE =
  /\b(fyi|for your (?:information|awareness|records|reference)|just (?:a )?(?:heads[- ]up|so you know)|no action (?:is )?(?:needed|required|necessary)|nothing (?:is )?(?:needed|required) from you|status (?:report|update)|(?:daily|weekly|monthly|quarterly) (?:report|digest|summary|roundup|recap)|newsletter|read[- ]only|informational(?:ly)? )\b/i;

/**
 * Local-parts that are machine mailboxes outright. Matched exactly against
 * the local part with any `+tag` suffix stripped.
 */
const AUTOMATED_LOCALPARTS = new Set([
  "admin",
  "alert",
  "alerts",
  "auto",
  "automated",
  "bounce",
  "bounces",
  "daemon",
  "mailer",
  "mailer-daemon",
  "noreply",
  "notification",
  "notifications",
  "postmaster",
  "robot",
  "system",
]);

/**
 * Substrings that mark a machine mailbox wherever they appear in the local
 * part, so `aws-marketing-no-reply` and `bounces-1234` are both caught.
 */
const AUTOMATED_LOCALPART_FRAGMENTS = [
  "noreply",
  "no-reply",
  "no_reply",
  "no.reply",
  "donotreply",
  "do-not-reply",
  "do_not_reply",
  "mailer-daemon",
];

/**
 * Service-account naming conventions in use at PSD. Named in #1855 as
 * signals that an address is a machine rather than a colleague.
 */
const AUTOMATED_LOCALPART_PREFIXES = ["serv_", "svc_", "svc-", "tsd-", "noreply"];

/** Recipient fan-out at or above which a message reads as broadcast mail. */
export const BROADCAST_RECIPIENT_COUNT = 8;

/**
 * Pull bare addresses out of an RFC-5322 address list. Tolerant of display
 * names, quoting and group syntax — anything that looks like an address is
 * returned, lowercased.
 */
export function parseAddressList(headerValue: string | undefined): string[] {
  if (!headerValue) return [];
  const matches = headerValue.match(/[\w!#$%&'*+/=?^`{|}~.-]+@[\w.-]+\.[A-Za-z]{2,}/g);
  return matches ? matches.map((address) => address.toLowerCase()) : [];
}

/**
 * Does this address speak for a machine rather than a person?
 *
 * Header evidence wins over the local part: `List-Unsubscribe`,
 * `Auto-Submitted` and a bulk `Precedence` are the standards-defined ways
 * for a sender to say "this is automated", and they catch the automated
 * mail that uses a human-looking From address.
 */
export function isAutomatedSender(
  fromEmail: string,
  headers: MessageHeaders = {},
): boolean {
  if (headers.listUnsubscribe && headers.listUnsubscribe.trim()) return true;
  const autoSubmitted = (headers.autoSubmitted ?? "").trim().toLowerCase();
  if (autoSubmitted && autoSubmitted !== "no") return true;
  const precedence = (headers.precedence ?? "").trim().toLowerCase();
  if (["bulk", "list", "junk", "auto_reply"].includes(precedence)) return true;

  const localPart = (fromEmail.split("@")[0] ?? "").toLowerCase().split("+")[0];
  if (!localPart) return false;
  if (AUTOMATED_LOCALPARTS.has(localPart)) return true;
  if (AUTOMATED_LOCALPART_FRAGMENTS.some((f) => localPart.includes(f))) return true;
  return AUTOMATED_LOCALPART_PREFIXES.some((p) => localPart.startsWith(p));
}

function deriveShape(
  signals: Omit<ContentSignals, "shape">,
): ContentShape {
  if (signals.approvalRequest) return "approval";
  if (signals.liveThread) return "live-thread";
  if (signals.directQuestion || signals.actionRequest) return "direct-ask";
  if (signals.automatedSender) return "notification";
  if (signals.informational || signals.ccOnly || signals.broadcast) return "fyi";
  return "unknown";
}

/**
 * Derive every content signal for one message. Subject and opening body
 * text are searched together because an ask lives in either one ("Approval
 * needed" in the subject, "can you confirm?" in the body).
 */
export function detectContentSignals(
  input: ContentSignalInput,
): ContentSignals {
  const opening = `${input.subject}\n${input.body}`.slice(
    0,
    OPENING_TEXT_CHARS + input.subject.length,
  );
  const userEmail = input.userEmail.toLowerCase();
  const toAddresses = parseAddressList(input.headers.to);
  const ccAddresses = parseAddressList(input.headers.cc);
  const addressedToUser = toAddresses.includes(userEmail);
  const ccOnly = !addressedToUser && ccAddresses.includes(userEmail);
  const automatedSender = isAutomatedSender(input.fromEmail, input.headers);

  // Ask detection runs against the text with withdrawals removed;
  // `informational` runs against the original, where those same phrases
  // are the signal.
  const askText = opening.replace(NEGATED_ASK_RE, " ");

  const base = {
    directQuestion: askText.includes("?"),
    actionRequest: ACTION_RE.test(askText),
    approvalRequest: APPROVAL_RE.test(askText),
    deadline: DEADLINE_RE.test(askText),
    addressedToUser,
    ccOnly,
    broadcast:
      Boolean(input.headers.listUnsubscribe) ||
      toAddresses.length + ccAddresses.length >= BROADCAST_RECIPIENT_COUNT,
    liveThread:
      input.hasUserReply &&
      Boolean(
        input.headers.inReplyTo ||
          input.headers.references ||
          /^\s*re\s*:/i.test(input.subject),
      ),
    informational: INFORMATIONAL_RE.test(opening),
    automatedSender,
  };
  return { ...base, shape: deriveShape(base) };
}

/** True when the message asks the reader for something. */
export function hasAsk(signals: ContentSignals): boolean {
  return (
    signals.directQuestion ||
    signals.actionRequest ||
    signals.approvalRequest ||
    signals.deadline
  );
}

export interface ContentDecision {
  label: "important" | "later";
  reason: string;
}

/**
 * Deterministic, sender-identity-independent classification.
 *
 * Runs after the user's own rules and before the LLM. Every branch here is
 * decided by what the message asks and who it is addressed to, so the same
 * message body routed through two different relays lands on the same label
 * — the acceptance criterion in #1855 item 4.
 *
 * Returns null when the content is genuinely ambiguous; the LLM then
 * decides, still with the content signals in front of it.
 */
export function classifyByContent(
  signals: ContentSignals,
): ContentDecision | null {
  // An approval or signature request is important even when a machine sent
  // it and even when the user will act on it in another system — #1855
  // addendum 2 item 7 calls these out specifically.
  if (signals.approvalRequest) {
    return {
      label: "important",
      reason: "content:approval-or-signature-requested",
    };
  }
  if (signals.liveThread) {
    return {
      label: "important",
      reason: "content:reply-in-a-thread-you-are-in",
    };
  }
  if (signals.addressedToUser && (signals.directQuestion || signals.actionRequest)) {
    return {
      label: "important",
      reason: signals.directQuestion
        ? "content:direct-question-addressed-to-you"
        : "content:action-requested-of-you",
    };
  }
  if (!hasAsk(signals)) {
    if (signals.automatedSender) {
      return { label: "later", reason: "content:automated-notice-no-ask" };
    }
    if (signals.informational) {
      return { label: "later", reason: "content:fyi-nothing-asked-of-you" };
    }
    if (signals.ccOnly || signals.broadcast) {
      return { label: "later", reason: "content:you-are-not-the-recipient" };
    }
  }
  return null;
}

/** Render the signals as prompt lines the model can reason over. */
export function describeContentSignals(signals: ContentSignals): string {
  const recipient = signals.addressedToUser
    ? "the user is in To"
    : signals.ccOnly
      ? "the user is only on Cc"
      : "the user is not named in To or Cc";
  return [
    `  - shape: ${signals.shape}`,
    `  - asks a question in the opening text: ${signals.directQuestion}`,
    `  - requests an action from the reader: ${signals.actionRequest}`,
    `  - requests an approval or signature: ${signals.approvalRequest}`,
    `  - names a deadline: ${signals.deadline}`,
    `  - recipient role: ${recipient}`,
    `  - reply inside a thread the user is in: ${signals.liveThread}`,
    `  - FYI / status / digest language: ${signals.informational}`,
    `  - broadcast or list mail: ${signals.broadcast}`,
    `  - sender is an automated mailbox: ${signals.automatedSender}`,
  ].join("\n");
}
