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

import type { Label } from "./rules";

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
  | "bulk"
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
  /**
   * The opening text puts a question to the reader — a question clause
   * that speaks to them in the second person, not merely a question mark
   * somewhere in the text (#1861).
   */
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
  /**
   * FYI / status / digest language with nothing asked of the reader, or
   * bulk-mail footer boilerplate (#1861).
   */
  informational: boolean;
  /** The sender speaks for a machine rather than a person. */
  automatedSender: boolean;
  /**
   * A broadcast publication rather than mail written to this reader: a
   * newsletter, a digest, an association mailing, a vendor blast. Proven
   * from bulk/list headers, or from publication/marketing language in mail
   * a machine sent (#1866).
   */
  bulkPublication: boolean;
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
 * Bulk-mail footer boilerplate (#1861 item 4). These phrases only mean
 * "marketing" in mail a machine sent — "go ahead and" is ordinary English
 * from a colleague — so they are only consulted when the sender is already
 * an automated or list sender. See `detectContentSignals`.
 */
/*
 * Plain literals rather than one alternation regex: the regex form stacked
 * optional groups ("manage (?:your )?(?:email )?preferences") and tripped
 * `security/detect-unsafe-regex`. A substring scan over lowercased text is
 * ReDoS-free by construction, and the same array ports verbatim into
 * `lib.js`, which is what keeps the two copies in parity.
 */
export const MARKETING_FOOTER_PHRASES = [
  "unsubscribe",
  "manage your preferences",
  "manage your email preferences",
  "manage email preferences",
  "update your preferences",
  "update your email preferences",
  "opt out of these",
  "opt-out of these",
  "you are receiving this",
  "you're receiving this",
  "this email was sent to",
  "this e-mail was sent to",
  "this message was sent to",
  "view this in your browser",
  "view this email in your browser",
  "view it in your browser",
  "view in browser",
  "add us to your address book",
  "add us to your safe sender",
  // Both named verbatim in #1861 item 4 as phrases to detect. "go ahead
  // and" is ordinary English, which is why the whole list is gated on
  // `automatedSender` — see `detectContentSignals`.
  "go ahead and",
  "think this is awesome",
];

function hasMarketingFooter(text: string): boolean {
  const lower = text.toLowerCase();
  return MARKETING_FOOTER_PHRASES.some((phrase) => lower.includes(phrase));
}

/**
 * FYI / status / digest language, bulk list mail, or marketing-footer
 * boilerplate from a machine (#1861 item 4). Extracted from
 * `detectContentSignals` to keep that function under the complexity bar.
 */
function isInformational(
  opening: string,
  bulkHeader: boolean,
  automatedSender: boolean,
): boolean {
  if (INFORMATIONAL_RE.test(opening)) return true;
  if (bulkHeader) return true;
  return automatedSender && hasMarketingFooter(opening);
}

/**
 * `Precedence` values that declare the message is list/bulk traffic. The
 * other values `isAutomatedSender` accepts (`junk`, `auto_reply`) say
 * "a machine sent this", which is not the same claim as "this is a
 * publication", so they are deliberately absent.
 */
const BULK_PRECEDENCE = new Set(["bulk", "list"]);

/**
 * Publication vocabulary — the words a periodical uses about itself. Only
 * consulted for mail a machine sent, because a colleague writing "here's
 * my weekly recap" is not a newsletter.
 *
 * Deliberately narrower than `INFORMATIONAL_RE`: "fyi" and "status update"
 * describe a one-off notice, and reading those as a publication would file
 * real notices under News.
 */
export const PUBLICATION_RE =
  /\b(newsletter|news ?letter|digest|bulletin|round[- ]?up|recap|highlights|top stories|this week in|latest issue|new (?:post|issue|edition)|press release|webinar|e[- ]?blast)\b/i;

/**
 * Is this a broadcast publication rather than mail written to this reader?
 *
 * Headers settle it on their own: `List-Unsubscribe` and a bulk/list
 * `Precedence` are how a sender declares "this went to a list", which is
 * exactly the newsletter/digest/association-mailing shape #1866 asks for.
 *
 * Without those headers the sender must at least be a machine, and the
 * message must then look like a publication — a large recipient fan-out,
 * publication vocabulary, or marketing-footer boilerplate. A machine
 * notice addressed to one person with none of that ("your password was
 * reset") is NOT a publication and must not be filed under News.
 */
function isBulkPublication(
  opening: string,
  bulkHeader: boolean,
  automatedSender: boolean,
  broadcast: boolean,
): boolean {
  // A person is never a publication, list header or not (see
  // `isAutomatedMessageSender`). For every other sender a list header
  // already makes `automatedSender` true, so this order changes nothing.
  if (!automatedSender) return false;
  if (bulkHeader) return true;
  return (
    broadcast || PUBLICATION_RE.test(opening) || hasMarketingFooter(opening)
  );
}

/**
 * A second-person reference. `directQuestion` requires one inside the
 * question clause itself, so a rhetorical marketing question ("Think this
 * is awesome?") is not read as an ask (#1861 item 1).
 *
 * Contractions need no alternative of their own: an apostrophe — straight
 * or curly — is a non-word character, so `\byou\b` already matches
 * "you're", "you’ll" and friends.
 */
const SECOND_PERSON_RE = /\b(you|your|yours|yourself)\b/i;

/**
 * `.`, `!` and `?` each close the clause before them — but see
 * `isSentenceBoundary` for the one case where a character in this set is
 * not actually a sentence boundary.
 *
 * A single newline deliberately is NOT in this set. In a hard-wrapped
 * plain-text or forwarded body the newline is just where the mail client
 * wrapped the line, not a sentence boundary, so treating it as one lost
 * real questions: "Could you confirm\nthe budget by Friday?" tested only
 * "the budget by Friday" and missed the "you" on the line above. A BLANK
 * line does separate thoughts, and is handled by `PARAGRAPH_BREAK_RE`.
 */
const CLAUSE_TERMINATORS = new Set([".", "!", "?"]);

/** Letters and digits — the characters a dot can sit *inside*. */
const ALPHANUMERIC_RE = /[a-z0-9]/i;

/**
 * Is the character at `index` really ending a sentence?
 *
 * `!` and `?` always are. A `.` is not when it sits INSIDE a token — a
 * version, a hostname, a decimal, an initialism. Without this, every such
 * dot reset the clause and swallowed the second-person reference before
 * it: "What do you think of v1.2?", "...of example.com?", "Can you review
 * https://psd401.net/doc?" and "Did you see the 3.5 GPA report?" all
 * returned false, so a real question to the user lost its deterministic
 * `important` and fell through to the model.
 *
 * Known remaining edge: a mid-sentence abbreviation whose final dot IS
 * followed by a space ("..., i.e. the draft?") still splits the clause.
 * Closing that needs an abbreviation list, which is not worth the weight
 * — the model still sees the message and every other signal.
 */
function isSentenceBoundary(text: string, index: number): boolean {
  const char = text[index];
  if (char !== ".") return true;
  return !(
    ALPHANUMERIC_RE.test(text[index - 1] ?? "") &&
    ALPHANUMERIC_RE.test(text[index + 1] ?? "")
  );
}

/** A blank line — the one newline-ish thing that really does end a thought. */
const PARAGRAPH_BREAK_RE = /\n[ \t]*\n/;

/** Every remaining newline, collapsed to a space before clauses are cut. */
const NEWLINE_RE = /\n/g;

/**
 * Does the text put a question to the READER?
 *
 * The pre-#1861 test was `text.includes("?")`, which fired on any question
 * mark anywhere — including the marketing line "Think this is awesome? Go
 * ahead and …" in a Google Search Console blast, which then scored
 * `important` and pinged Chat. A question only counts when the clause it
 * terminates speaks to the reader in the second person — a "your" in the
 * NEXT sentence must not rescue a rhetorical question.
 *
 * Scanned by hand rather than with `/[^.!?\n]*\?/g`, which is QUADRATIC on
 * text containing no question mark: the star consumes to the end, fails,
 * backtracks, and the whole walk repeats from the next start position.
 * `eslint security/detect-unsafe-regex` does not flag it, but measured at
 * 2.5s for 64KB and rising 16x per 4x of length — and this text is
 * attacker-controlled (any sender's subject and body, and the
 * `OPENING_TEXT_CHARS` cap does not bound the subject). This loop is
 * linear: each character is visited once, and each clause is tested once.
 */
export function hasDirectQuestion(text: string): boolean {
  for (const paragraph of text.split(PARAGRAPH_BREAK_RE)) {
    if (scanQuestionClauses(paragraph.replace(NEWLINE_RE, " "))) return true;
  }
  return false;
}

/** One paragraph, line wraps already flattened. See `hasDirectQuestion`. */
function scanQuestionClauses(paragraph: string): boolean {
  let clauseStart = 0;
  for (let i = 0; i < paragraph.length; i += 1) {
    const char = paragraph[i] as string;
    if (!CLAUSE_TERMINATORS.has(char)) continue;
    if (!isSentenceBoundary(paragraph, i)) continue;
    if (char === "?" && SECOND_PERSON_RE.test(paragraph.slice(clauseStart, i))) {
      return true;
    }
    clauseStart = i + 1;
  }
  return false;
}

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
  // Publication mailboxes (#1866). A mailbox literally named `newsletter`
  // or `digest` speaks for a periodical, not a colleague, and without
  // these a newsletter that carries no List-Unsubscribe (K-12 Dive in the
  // reported corpus) read as a person and could never reach News.
  // Deliberately only the unambiguous ones. `info`, `support` and `sales`
  // are staffed by people, and so are many `news@`, `marketing@`,
  // `bulletin@` and `digest@` boxes (a comms office, a vendor's PR desk):
  // they are NOT here, because this set also decides which senders the
  // learner may suggest muting and which mutes `suggestions apply` lets
  // through without `--confirm-human`. Those mailboxes still reach News
  // whenever they send with List-Unsubscribe or a bulk Precedence.
  "e-news",
  "enews",
  "mailings",
  "newsletter",
  "newsletters",
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
  // No "newsletter" fragment (#1866 review): a substring match would make
  // `newsletter-editor@` or `jdoe.newsletter@` — a person who runs the
  // newsletter — mutable without `--confirm-human`. Only the exact
  // `newsletter@` / `newsletters@` mailboxes are listed above; any other
  // newsletter reaches News through its list header.
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

/**
 * `isAutomatedSender` for one message, with a colleague's list post kept
 * a person (#1866). A post by `jsmith@psd401.net` to a district Google
 * Group arrives with `List-Unsubscribe` and `Precedence: list`, which
 * would otherwise read the colleague as a machine and their post as a
 * publication — News. For a sender on the user's own domain the list
 * headers are discounted, so the post stays a person's mail (Later at
 * most). `Auto-Submitted` and a non-list `Precedence` still count (an
 * out-of-office reply is still automated), and so does a machine-shaped
 * local part (`newsletter@`, `noreply@`, `serv_*`).
 */
function isAutomatedMessageSender(
  fromEmail: string,
  userEmail: string,
  headers: MessageHeaders,
): boolean {
  const fromDomain = (fromEmail.split("@")[1] ?? "").toLowerCase();
  const userDomain = userEmail.split("@")[1] ?? "";
  if (!fromDomain || fromDomain !== userDomain) {
    return isAutomatedSender(fromEmail, headers);
  }
  const precedence = (headers.precedence ?? "").trim().toLowerCase();
  return isAutomatedSender(fromEmail, {
    ...headers,
    listUnsubscribe: undefined,
    precedence: BULK_PRECEDENCE.has(precedence) ? undefined : headers.precedence,
  });
}

function deriveShape(
  signals: Omit<ContentSignals, "shape">,
): ContentShape {
  if (signals.approvalRequest) return "approval";
  if (signals.liveThread) return "live-thread";
  if (signals.directQuestion || signals.actionRequest) return "direct-ask";
  // Before `notification`: both are machine mail, but a publication and a
  // one-off service notice are different kinds of message and corrections
  // against one must not move the other (#1866).
  if (signals.bulkPublication) return "bulk";
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
  const automatedSender = isAutomatedMessageSender(
    input.fromEmail,
    userEmail,
    input.headers,
  );

  // Ask detection runs against the text with withdrawals removed;
  // `informational` runs against the original, where those same phrases
  // are the signal.
  const askText = opening.replace(NEGATED_ASK_RE, " ");

  // The subject and the body are scanned for a question SEPARATELY. The
  // seam between them has to stay a hard boundary now that a newline is
  // not one (see `CLAUSE_TERMINATORS`), or a subject with no terminal
  // punctuation would bleed into the body's first clause and lend it a
  // second-person word: subject "Your weekly report" + body "Think this
  // is awesome?" must not read as a question to the reader. The body is
  // cut to the same `OPENING_TEXT_CHARS` that `opening` gives it.
  const subjectAskText = input.subject.replace(NEGATED_ASK_RE, " ");
  const bodyAskText = input.body
    .slice(0, OPENING_TEXT_CHARS)
    .replace(NEGATED_ASK_RE, " ");

  // List mail announces itself as bulk through List-Unsubscribe; that is
  // enough on its own to read the message as informational (#1861 item 4).
  const listMail = Boolean((input.headers.listUnsubscribe ?? "").trim());
  // A bulk/list `Precedence` is the other standards-defined way to say
  // "this went to a list" (#1866).
  const bulkHeader =
    listMail ||
    BULK_PRECEDENCE.has((input.headers.precedence ?? "").trim().toLowerCase());

  const broadcast =
    bulkHeader || toAddresses.length + ccAddresses.length >= BROADCAST_RECIPIENT_COUNT;

  const base = {
    directQuestion:
      hasDirectQuestion(subjectAskText) || hasDirectQuestion(bodyAskText),
    actionRequest: ACTION_RE.test(askText),
    approvalRequest: APPROVAL_RE.test(askText),
    deadline: DEADLINE_RE.test(askText),
    addressedToUser,
    ccOnly,
    broadcast,
    liveThread:
      input.hasUserReply &&
      Boolean(
        input.headers.inReplyTo ||
          input.headers.references ||
          /^\s*re\s*:/i.test(input.subject),
      ),
    informational: isInformational(opening, bulkHeader, automatedSender),
    automatedSender,
    bulkPublication: isBulkPublication(
      opening,
      bulkHeader,
      automatedSender,
      broadcast,
    ),
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
  label: Label;
  reason: string;
}

export interface ContentDecisionOptions {
  /**
   * True when the user has written their own preference profile.
   *
   * The stage then decides only the cases it is actually certain about and
   * hands the judgement calls to the model, which is the only stage that
   * reads the user's words (#1866). Without this the stage's fixed
   * `later` for machine mail fired first and the stated preference never
   * got a vote.
   */
  hasStatedPreferences?: boolean;
  /**
   * Shapes this user's corrections strongly lean News (`learnedNewsShapes`
   * in llm.ts). A machine notice of one of these shapes is filed as News
   * here, because the stage decides it before the model-path guard that
   * would otherwise apply the leaning ever runs (#1866 review).
   */
  learnedNewsShapes?: readonly ContentShape[];
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
  options: ContentDecisionOptions = {},
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
  // A question or a soft ask only earns `important` from a sender that
  // could actually be waiting on a reply. An automated or bulk sender is
  // vetoed here (#1861 item 2): marketing copy is full of second-person
  // questions and "let me know" phrasing, and nobody is on the other end
  // of a noreply mailbox. Those messages fall through to the LLM (which
  // still sees every signal) or to the default `later`. An approval or
  // signature request is exempt — it returned above — because a service
  // desk legitimately asks for one from a noreply address.
  if (
    signals.addressedToUser &&
    !signals.automatedSender &&
    (signals.directQuestion || signals.actionRequest)
  ) {
    return {
      label: "important",
      reason: signals.directQuestion
        ? "content:direct-question-addressed-to-you"
        : "content:action-requested-of-you",
    };
  }
  if (!hasAsk(signals)) return classifyNoAsk(signals, options);
  return null;
}

/**
 * The nothing-is-asked-of-you half of `classifyByContent`, split out to
 * keep each function under the complexity bar.
 */
function classifyNoAsk(
  signals: ContentSignals,
  options: ContentDecisionOptions,
): ContentDecision | null {
  // A newsletter, digest, association mailing or vendor blast is News,
  // not Later. Before #1866 the stage had no News outcome at all, so every
  // one of these landed in Later and the user was back to writing keyword
  // rules for them.
  if (signals.bulkPublication) {
    return { label: "news", reason: "content:bulk-publication-no-ask" };
  }
  if (signals.automatedSender) {
    // A one-off machine notice with nothing asked (a password reset, a
    // sync report). Later vs News here is a judgement call, not a
    // certainty: hand it to the model when the user has told us how they
    // want it judged, and keep the old default when they have not. A
    // shape the user keeps re-filing as News is not a judgement call.
    if (options.learnedNewsShapes?.includes(signals.shape)) {
      return {
        label: "news",
        reason: `content:learned-you-file-${signals.shape}-mail-as-news`,
      };
    }
    if (options.hasStatedPreferences) return null;
    return { label: "later", reason: "content:automated-notice-no-ask" };
  }
  if (signals.informational) {
    return { label: "later", reason: "content:fyi-nothing-asked-of-you" };
  }
  if (signals.ccOnly || signals.broadcast) {
    return { label: "later", reason: "content:you-are-not-the-recipient" };
  }
  return null;
}

/**
 * Reporting order for `firedContentSignals` — the declaration order of
 * `ContentSignals` above, so the list is stable across calls and across
 * the TS/JS copies.
 *
 * Deliberately NOT a claim about which signal "won". An earlier version of
 * this list claimed to mirror the order `classifyByContent` consults the
 * signals in, which it could not: `deadline` is never branched on directly
 * (it only feeds `hasAsk`), `automatedSender` is consulted twice at
 * different points (once as a veto, once as a positive branch), and
 * `addressedToUser` only ever matters as a conjunct. Nothing could enforce
 * that correspondence, so a reorder of `classifyByContent` would have
 * silently made this report a misleading "most likely culprit". The
 * deciding branch is already named exactly, by the `reason` string.
 */
const SIGNAL_REPORT_ORDER: (keyof Omit<ContentSignals, "shape">)[] = [
  "directQuestion",
  "actionRequest",
  "approvalRequest",
  "deadline",
  "addressedToUser",
  "ccOnly",
  "broadcast",
  "liveThread",
  "informational",
  "automatedSender",
  "bulkPublication",
];

/**
 * The names of the signals that are true. `simulate` prints this alongside
 * the decision's `reason`, so "which signal fired?" is answerable without
 * reading a ten-key boolean map (#1861 acceptance).
 */
export function firedContentSignals(signals: ContentSignals): string[] {
  return SIGNAL_REPORT_ORDER.filter((name) => signals[name] === true);
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
    `  - puts a second-person question to the reader: ${signals.directQuestion}`,
    `  - requests an action from the reader: ${signals.actionRequest}`,
    `  - requests an approval or signature: ${signals.approvalRequest}`,
    `  - names a deadline: ${signals.deadline}`,
    `  - recipient role: ${recipient}`,
    `  - reply inside a thread the user is in: ${signals.liveThread}`,
    `  - FYI / status / digest language: ${signals.informational}`,
    `  - broadcast or list mail: ${signals.broadcast}`,
    `  - sender is an automated mailbox: ${signals.automatedSender}`,
    `  - broadcast publication (newsletter / digest / list mailing): ${signals.bulkPublication}`,
  ].join("\n");
}
