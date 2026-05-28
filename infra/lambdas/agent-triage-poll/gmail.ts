/**
 * Thin Gmail REST client used by the classifier Lambda.
 *
 * Direct `fetch` against the v1 REST endpoints — we don't need the full
 * `@googleapis/gmail` package's surface (it pulls in ~5 MB of generated
 * code we'd only use 5% of) and keeping the deps tight matters for
 * Lambda cold start.
 */

export interface HistoryEvent {
  id: string;
  messages?: { id: string; threadId: string }[];
  messagesAdded?: { message: { id: string; threadId: string; labelIds?: string[] } }[];
  labelsAdded?: {
    message: { id: string; threadId: string; labelIds?: string[] };
    labelIds: string[];
  }[];
  labelsRemoved?: {
    message: { id: string; threadId: string; labelIds?: string[] };
    labelIds: string[];
  }[];
}

export interface HistoryResponse {
  history?: HistoryEvent[];
  historyId?: string;
  nextPageToken?: string;
}

export interface MessageResponse {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: MessagePart;
}

interface MessagePart {
  mimeType?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
  parts?: MessagePart[];
}

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

async function gmailFetch(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const resp = await fetch(`${GMAIL_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  return resp;
}

/**
 * Get the user's current Gmail historyId. Used at enable time to anchor
 * the classifier's starting cursor — we only classify mail received
 * after the user opts in.
 */
export async function getCurrentHistoryId(accessToken: string): Promise<string> {
  const resp = await gmailFetch(accessToken, "/profile");
  if (!resp.ok) {
    throw new Error(`Gmail profile fetch failed: ${resp.status} ${await resp.text()}`);
  }
  const profile = (await resp.json()) as { historyId: string };
  return profile.historyId;
}

/**
 * Fetch the diff of mailbox events since `startHistoryId`.
 *
 * Gmail returns up to 100 events per call; we follow `nextPageToken`
 * until exhausted. We request only the history types we care about so
 * we skip unrelated noise (e.g. drafts).
 *
 * If the cursor is too old (>7 days, Gmail's history retention), the
 * call returns 404. The caller handles re-anchoring on the current
 * historyId in that case.
 */
export async function listHistory(
  accessToken: string,
  startHistoryId: string,
): Promise<{ events: HistoryEvent[]; latestHistoryId?: string; tooOld: boolean }> {
  const events: HistoryEvent[] = [];
  let pageToken: string | undefined;
  let latestHistoryId: string | undefined;
  let tooOld = false;

  do {
    const params = new URLSearchParams({
      startHistoryId,
      historyTypes: "messageAdded",
      maxResults: "100",
    });
    // Repeated params for the array case.
    params.append("historyTypes", "labelAdded");
    params.append("historyTypes", "labelRemoved");
    if (pageToken) params.set("pageToken", pageToken);

    const resp = await gmailFetch(accessToken, `/history?${params.toString()}`);
    if (resp.status === 404) {
      tooOld = true;
      break;
    }
    if (!resp.ok) {
      throw new Error(
        `Gmail history.list failed: ${resp.status} ${await resp.text()}`,
      );
    }
    const data = (await resp.json()) as HistoryResponse;
    if (data.history) events.push(...data.history);
    if (data.historyId) latestHistoryId = data.historyId;
    pageToken = data.nextPageToken;
  } while (pageToken);

  return { events, latestHistoryId, tooOld };
}

/**
 * Fetch the metadata of a single message — sender, subject, snippet,
 * labelIds. We deliberately use `format=metadata` to avoid downloading
 * full bodies (and exposing them to Bedrock prompt input).
 */
export async function getMessageMetadata(
  accessToken: string,
  messageId: string,
): Promise<MessageResponse | null> {
  const params = new URLSearchParams({
    format: "metadata",
    // Only the headers we actually use.
    metadataHeaders: "From",
  });
  params.append("metadataHeaders", "Subject");
  params.append("metadataHeaders", "Date");
  const resp = await gmailFetch(accessToken, `/messages/${messageId}?${params.toString()}`);
  if (resp.status === 404 || resp.status === 410) return null;
  if (!resp.ok) {
    throw new Error(
      `Gmail message fetch failed: ${resp.status} ${await resp.text()}`,
    );
  }
  return (await resp.json()) as MessageResponse;
}

/**
 * Fetch the full plain-text body of a message, cap at `maxChars`. Used
 * by the @psd/Task gesture so the agent can detect urgency markers
 * ("by EOD", "tomorrow", "ASAP") that wouldn't fit in the 400-char
 * snippet. Walks MIME parts depth-first; prefers `text/plain` over
 * `text/html`; falls back to snippet if no readable body found.
 */
export async function getMessageFullBody(
  accessToken: string,
  messageId: string,
  maxChars = 4000,
): Promise<string | null> {
  const resp = await gmailFetch(accessToken, `/messages/${messageId}?format=full`);
  if (resp.status === 404 || resp.status === 410) return null;
  if (!resp.ok) {
    throw new Error(
      `Gmail full message fetch failed: ${resp.status} ${await resp.text()}`,
    );
  }
  const msg = (await resp.json()) as MessageResponse;
  const body = extractPlainText(msg.payload) ?? msg.snippet ?? "";
  return body.slice(0, maxChars);
}

function extractPlainText(part: MessagePart | undefined): string | null {
  if (!part) return null;
  // Single-part text — decode if it matches text/*.
  if (part.body?.data && (!part.mimeType || part.mimeType.startsWith("text/"))) {
    const decoded = decodeBase64Url(part.body.data);
    if (part.mimeType === "text/html") return stripHtml(decoded);
    return decoded;
  }
  // Multipart — walk children, prefer text/plain.
  if (part.parts) {
    const plain = part.parts.find((p) => p.mimeType === "text/plain");
    if (plain?.body?.data) return decodeBase64Url(plain.body.data);
    for (const child of part.parts) {
      const found = extractPlainText(child);
      if (found) return found;
    }
  }
  return null;
}

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64").toString("utf8");
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pull `From` header → bare email; falls back to the raw header value. */
export function extractFromEmail(msg: MessageResponse): string {
  const fromHeader = msg.payload?.headers?.find((h) => h.name.toLowerCase() === "from")?.value ?? "";
  // Match `Name <addr@host>` or bare `addr@host`. Lowercase.
  const match = fromHeader.match(/<([^>]+)>/) ?? fromHeader.match(/([\w.+-]+@[\w.-]+\.[a-zA-Z]{2,})/);
  return (match ? match[1] : fromHeader).trim().toLowerCase();
}

export function extractSubject(msg: MessageResponse): string {
  return (
    msg.payload?.headers?.find((h) => h.name.toLowerCase() === "subject")?.value ?? ""
  );
}

/**
 * Add a label to a message (we never REMOVE labels — that's user
 * territory). `removeLabelIds: ["INBOX"]` auto-archives, used when the
 * decision is `later` or `news`.
 */
export async function modifyMessage(
  accessToken: string,
  messageId: string,
  addLabelIds: string[],
  removeLabelIds: string[] = [],
): Promise<void> {
  const resp = await gmailFetch(accessToken, `/messages/${messageId}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });
  if (!resp.ok) {
    throw new Error(
      `Gmail messages.modify failed for ${messageId}: ${resp.status} ${await resp.text()}`,
    );
  }
}

/**
 * Modify labels on EVERY message in a thread. Used by the @psd/Task
 * gesture archive step so that labeling any single message in a thread
 * causes the whole thread to be archived (matches Gmail's UX where a
 * thread shows in Inbox if any message has INBOX). Avoids the
 * 2026-05-22 dup-issue bug where threads with multiple messages each
 * fired their own labelsAdded event → multiple gestures → multiple
 * GitHub issues.
 */
export async function modifyThread(
  accessToken: string,
  threadId: string,
  addLabelIds: string[],
  removeLabelIds: string[] = [],
): Promise<void> {
  const resp = await gmailFetch(accessToken, `/threads/${threadId}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds, removeLabelIds }),
  });
  if (!resp.ok) {
    throw new Error(
      `Gmail threads.modify failed for ${threadId}: ${resp.status} ${await resp.text()}`,
    );
  }
}

/**
 * Check whether the user has a SENT message in the same thread. Used
 * by the rules engine's "user-replied-here" signal — a strong indicator
 * that incoming mail in this thread matters.
 *
 * Cheap: thread metadata + label scan, no body download.
 */
export async function threadHasUserReply(
  accessToken: string,
  threadId: string,
): Promise<boolean> {
  const resp = await gmailFetch(
    accessToken,
    `/threads/${threadId}?format=minimal`,
  );
  if (!resp.ok) return false;
  const data = (await resp.json()) as {
    messages?: { labelIds?: string[] }[];
  };
  return Boolean(
    data.messages?.some((m) => (m.labelIds ?? []).includes("SENT")),
  );
}
