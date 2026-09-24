/**
 * One-shot handshake that lets an IN-APP navigation ask the Nexus composer to
 * send its prefilled draft, without making `?send=1` a thing anyone can put in
 * a link (#1791 finding 2).
 *
 * The problem: the Atrium "Ask the agent" card prefills the composer via
 * `?draft=` and stops there, so the person has to press send a second time, on
 * a different page, to ask the question they already asked. Auto-sending on a
 * bare URL flag would be worse: a link someone is sent — in an email, a chat
 * message, another site — could then run an arbitrary prompt in their Nexus
 * session, against whatever workspace `?workspace=` names, with their own
 * tools and their own permissions.
 *
 * So the URL flag alone is never enough. `arm()` writes a nonce → draft entry
 * into `sessionStorage` immediately before `router.push`, and `consume()`
 * honours the flag only when the stored draft for that nonce matches the draft
 * actually in the URL. sessionStorage is per-origin and per-tab, so a link
 * opened from outside the app has no entry and simply prefills, exactly as it
 * does today. The entry is deleted on the first read, so a reload or a Back
 * navigation re-prefills rather than sending again.
 *
 * Storage failures are never fatal: a private window or blocked site data
 * degrades to the current prefill-only behaviour rather than throwing.
 */

const KEY_PREFIX = "nexus:draft-autosend:";

/** URL parameter carrying the nonce. Paired with the existing `draft` param. */
export const DRAFT_AUTO_SEND_PARAM = "send";

function storage(): Storage | null {
  try {
    // Accessing sessionStorage itself throws when site data is blocked.
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

function newNonce(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Arm auto-send for `draft` and return the nonce to put in the URL, or null
 * when storage is unavailable — in which case the caller should link without
 * the flag, because an unbacked flag would never be honoured anyway.
 */
export function armDraftAutoSend(draft: string): string | null {
  const store = storage();
  if (!store || !draft) return null;
  const nonce = newNonce();
  try {
    store.setItem(KEY_PREFIX + nonce, draft);
  } catch {
    return null;
  }
  return nonce;
}

/**
 * Consume the handshake. Returns true exactly once, and only when this tab
 * armed this nonce for this exact draft. Always clears the entry, so a
 * mismatched or replayed nonce cannot linger.
 */
export function consumeDraftAutoSend(
  nonce: string | null,
  draft: string
): boolean {
  if (!nonce || !draft) return false;
  const store = storage();
  if (!store) return false;
  const key = KEY_PREFIX + nonce;
  try {
    const stored = store.getItem(key);
    // Removed unconditionally, so a mismatched or replayed nonce cannot linger.
    store.removeItem(key);
    return stored !== null && stored === draft;
  } catch {
    return false;
  }
}
