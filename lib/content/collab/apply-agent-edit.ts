/**
 * Atrium agent bridge — apply an agent edit to the live document
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1). Lets a server-side agent push markdown
 * into the live collaborative document, attributed to the agent (purple rail). The
 * rebuilt equivalent of Proof's `rewrite` bridge operation.
 *
 * It applies the edit as a y-sync CLIENT of the collab server (a raw `ws` socket
 * speaking the y-protocols sync handshake — NOT y-websocket's WebsocketProvider,
 * which does not sync inside the Next.js server runtime). This is deliberate: the
 * agent-bridge route runs in the Next module graph while the websocket server runs
 * in the server.ts / voice-server.js graph — separate module instances with
 * separate in-memory doc registries (and separate bundles in prod). Connecting as a
 * client guarantees the edit lands on the SAME doc the editors are connected to, so
 * it broadcasts to them live (and persists + fans out via Redis). Works identically
 * in dev (no Redis) and prod.
 *
 * Guardrails + PII screening happen in the route BEFORE this is called.
 */

import { randomUUID } from "node:crypto";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { updateYFragment } from "y-prosemirror";
import type { JSONContent } from "@tiptap/core";
import { getCollabSchema } from "./editor-extensions";
import {
  markdownToProseMirrorJSON,
  stampAuthor,
  yDocToProseMirrorJSON,
} from "./markdown-bridge";
import { COLLAB_FIELD, makeAuthorTag } from "./provenance";
import { ATRIUM_COMMENT_MARK } from "./comment-mark";
import {
  ATRIUM_SUGGESTION_DELETE_MARK,
  ATRIUM_SUGGESTION_INSERT_MARK,
} from "./suggestion-marks";
import { signAgentCollabToken } from "./collab-token";
import { executeQuery } from "@/lib/db/drizzle-client";
import { atriumDocComments } from "@/lib/db/schema";
import { createLogger } from "@/lib/logger";

const log = createLogger({ context: "agent-bridge-client" });

export type AgentEditMode = "replace" | "append";

export interface AgentEditInput {
  objectId: string;
  /** Already guardrails/PII-cleared markdown the agent wants to write. */
  markdown: string;
  /** agent_identities.id (or label) — stamped as `ai:<agentId>` on the rail. */
  agentId: string;
  /** replace = rewrite the whole document; append = add blocks at the end. */
  mode?: AgentEditMode;
}

const COLLAB_WS_PATH = "/api/atrium-collab";
const MESSAGE_SYNC = 0;
const SYNC_STEP_2 = 1; // y-protocols/sync messageYjsSyncStep2
const SYNC_TIMEOUT_MS = 10_000;

/**
 * Hostnames the agent bridge is permitted to connect to. The bridge always talks
 * to the SAME process's collab websocket server, so the only legitimate target is
 * loopback. ECS deployments that need a different host (rare) can extend this via
 * COLLAB_INTERNAL_HOST_ALLOWLIST (comma-separated). This blocks SSRF: a tampered
 * COLLAB_INTERNAL_URL (e.g. `ws://169.254.169.254/...` or an attacker WS host)
 * would otherwise receive a valid signed collab JWT in the `?token=` query string.
 */
const DEFAULT_ALLOWED_HOSTS = ["127.0.0.1", "localhost", "[::1]", "::1"];

function resolveCollabBaseUrl(): string {
  const base = process.env.COLLAB_INTERNAL_URL ?? `ws://127.0.0.1:${process.env.PORT ?? "3000"}`;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new Error(`COLLAB_INTERNAL_URL is not a valid URL: ${base}`);
  }
  // Only the websocket schemes — never http(s)/file/etc. — and the JWT must not
  // be carried to anything but a vetted internal host.
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`COLLAB_INTERNAL_URL must use ws:// or wss:// (got ${parsed.protocol})`);
  }
  const extra = (process.env.COLLAB_INTERNAL_HOST_ALLOWLIST ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const allowed = new Set([...DEFAULT_ALLOWED_HOSTS, ...extra]);
  if (!allowed.has(parsed.hostname.toLowerCase())) {
    throw new Error(
      `COLLAB_INTERNAL_URL host "${parsed.hostname}" is not allowed; ` +
        `set COLLAB_INTERNAL_HOST_ALLOWLIST to permit it`
    );
  }
  return base;
}

/**
 * Settle delay after dispatching the Yjs update before resolving the promise.
 *
 * KNOWN LIMITATION: this is heuristic, not acknowledgement-based. The y-protocols
 * sync handshake gives us no application-level ack that the SERVER applied our
 * update — only that we sent it. We therefore wait a fixed window for the update
 * frame to flush over the socket before closing it. Under ECS load or Redis
 * backpressure the default 500 ms may be insufficient; raise COLLAB_AGENT_SETTLE_MS
 * (see .env.example) for those deployments. A future improvement would replace this
 * with a real round-trip ack (server echoes a state vector covering our update).
 *
 * Parsed with a strict IIFE rather than `Number(...) || 500`: an explicit `0`
 * (a deliberate "no settle delay") is falsy and `|| 500` would silently restore
 * 500, so the operator could never actually disable the delay. Only unset / blank /
 * non-numeric / negative fall back to the default; a deliberate 0 is honored.
 */
const AGENT_SETTLE_MS = ((): number => {
  const raw = process.env.COLLAB_AGENT_SETTLE_MS;
  if (raw === undefined || raw.trim() === "") return 500;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 500;
})();

/**
 * Thrown when a `comment` / `suggest:delete` op names a `quote` that cannot be
 * located as a contiguous span in the live document. Preserved as a typed error
 * through the loopback reject path so the bridge route can map it to a 422
 * (client sent a stale/unmatched anchor) rather than a generic 500.
 */
export class QuoteNotLocatedError extends Error {
  constructor(quote: string) {
    super(`quote not located in document: ${JSON.stringify(quote.slice(0, 80))}`);
    this.name = "QuoteNotLocatedError";
  }
}

/** Given the hydrated document's ProseMirror JSON, produce the next JSON to diff
 * into the Y.Doc. May throw (e.g. QuoteNotLocatedError) to abort the apply. */
type NextDocBuilder = (currentJson: JSONContent) => JSONContent;

/**
 * Open a short-lived y-sync client to the collab server, hydrate this object's
 * live Y.Doc, then diff `buildNextJson(currentDocJson)` into it via
 * `updateYFragment` — the SAME loopback path the original `replace`/`append`
 * write used. EVERY agent op (edit, comment, suggest) funnels through here so
 * they share one CRDT-safe apply and one attribution/lock contract; only the
 * builder differs. All marks are built through the single `getCollabSchema()`
 * (never a second schema), so agent-side marks map identically to the editor's.
 *
 * `buildNextJson` runs AFTER SyncStep2 (the doc is hydrated) and may THROW —
 * a QuoteNotLocatedError from an unmatched anchor rejects the returned promise
 * with the ORIGINAL typed error (not the wrapped generic), so callers can map it.
 */
async function runLoopbackEdit(
  objectId: string,
  agentId: string,
  buildNextJson: NextDocBuilder
): Promise<void> {
  // Short-TTL token: this loopback bridge completes in ≤SYNC_TIMEOUT_MS (10s),
  // so a 30s grant is ample and shrinks the ALB-access-log replay window vs. the
  // 5-minute browser token (the token rides in the `?token=` URL — see collab-token.ts).
  const token = await signAgentCollabToken({ sub: `agent:${agentId}`, oid: objectId, w: true });

  // COLLAB_INTERNAL_URL allows overriding the loopback target in ECS task definitions
  // where PORT may differ from the value server.ts actually binds on. Validated to a
  // ws(s):// scheme + allowlisted host so a tampered value cannot exfiltrate the
  // signed collab JWT to an attacker-controlled or metadata-service endpoint (SSRF).
  const base = resolveCollabBaseUrl();
  const url = `${base}${COLLAB_WS_PATH}/${objectId}?token=${encodeURIComponent(token)}`;
  const ydoc = new Y.Doc();
  // Use the runtime's native WebSocket (Node 22 / Bun) — the `ws` package has
  // import-interop issues inside the Next.js server runtime ("Unexpected server
  // response: 101"); the native client connects to our ws server like a browser.
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  // Track the ydoc update listener so it can be removed in the finally block,
  // preventing a stale listener from sending on a closing/closed socket.
  let registeredOnUpdate: ((update: Uint8Array) => void) | null = null;

  const applyEdit = (): void => {
    const schema = getCollabSchema();
    const nextJson = buildNextJson(yDocToProseMirrorJSON(ydoc));
    const node = schema.nodeFromJSON(nextJson);

    // Send the resulting Yjs update to the server, which applies + broadcasts it.
    const onUpdate = (update: Uint8Array): void => {
      // Guard readyState: if the socket is CLOSING/CLOSED when a Yjs update fires
      // (e.g. server-side close races the transaction), ws.send() throws
      // InvalidStateError outside the connect promise's try/catch. Only send when OPEN.
      if (ws.readyState !== WebSocket.OPEN) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeUpdate(enc, update);
      ws.send(encoding.toUint8Array(enc));
    };
    registeredOnUpdate = onUpdate;
    ydoc.on("update", onUpdate);
    ydoc.transact(() => {
      updateYFragment(ydoc, ydoc.getXmlFragment(COLLAB_FIELD), node, {
        mapping: new Map(),
        isOMark: new Map(),
      });
    }, "agent-bridge");
  };

  try {
    await new Promise<void>((resolve, reject) => {
      let applied = false;
      let settled = false;
      let settleTimer: ReturnType<typeof setTimeout> | null = null;
      const timer = setTimeout(() => {
        reject(new Error("collab sync timeout"));
      }, SYNC_TIMEOUT_MS);
      // Single resolution path so the settle timer and the close handler can't
      // BOTH resolve. Once the close handler resolves (the normal case — the
      // collab server closes the socket on last-conn cleanup before the settle
      // window elapses), the still-armed settle timer is cancelled, so it does
      // not fire a second (no-op) resolve after `finally` already tore down.
      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (settleTimer) { clearTimeout(settleTimer); settleTimer = null; }
        resolve();
      };

      ws.addEventListener("open", () => {
        // Ask the server for its current state.
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(enc, ydoc);
        ws.send(encoding.toUint8Array(enc));
      });

      ws.addEventListener("message", (ev: MessageEvent) => {
        try {
          const u8 = new Uint8Array(ev.data as ArrayBuffer);
          const decoder = decoding.createDecoder(u8);
          if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;
          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, MESSAGE_SYNC);
          const syncType = syncProtocol.readSyncMessage(decoder, enc, ydoc, ws);
          if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
          // Once the server's SyncStep2 has hydrated our doc, apply the edit once,
          // then allow time for the update to flush before resolving. Mark
          // `applied` ONLY after applyEdit() AND the settle timer both succeed:
          // if applyEdit() throws (e.g. ws.send() races OPEN->CLOSING and raises
          // InvalidStateError), `applied` stays false so the subsequent `close`
          // handler rejects rather than silently resolving an edit that never
          // transmitted (HTTP 200 with no edit landed).
          if (!applied && syncType === SYNC_STEP_2) {
            applyEdit();
            settleTimer = setTimeout(settle, AGENT_SETTLE_MS);
            applied = true;
          }
        } catch (e) {
          // A failure in the sync/apply path (the only branch that mutates the
          // doc) must FAIL the promise — not just log — so the bridge route
          // returns an error instead of a false HTTP 200. Previously this only
          // logged, so an InvalidStateError from ws.send() racing OPEN->CLOSING
          // left `applied` set by the old ordering and the close handler resolved
          // successfully (silent dropped edit). Log for observability AND reject.
          const msg = e instanceof Error ? e.message : String(e);
          log.error("Agent bridge sync/apply failed", { msg });
          clearTimeout(timer);
          // Preserve a QuoteNotLocatedError's type so the route maps it to 422;
          // wrap anything else as a generic apply failure (500).
          reject(e instanceof QuoteNotLocatedError ? e : new Error(`collab sync apply failed: ${msg}`));
        }
      });

      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("collab websocket error"));
      });

      // Without a close listener, a server-side 4401 (expired/rejected token)
      // fires 'close' — not 'error' — and the promise hangs for the full
      // SYNC_TIMEOUT_MS before the timer fires.
      // Guard: if the update was already dispatched and the settle timer
      // (AGENT_SETTLE_MS) is running, a clean server-side close is not an error —
      // the edit landed.
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        if (!applied) reject(new Error("collab websocket closed"));
        else settle();
      });
    });
  } finally {
    // Remove the ydoc listener before closing so any internal Yjs update fired
    // during close doesn't try to send on an already-closed socket.
    if (registeredOnUpdate) ydoc.off("update", registeredOnUpdate);
    try { ws.close(); } catch { /* already closed */ }
  }
}

/** Apply the agent's markdown to the live document via a short-lived y-sync client.
 *  `replace` rewrites the whole doc; `append` adds the agent's blocks at the end. */
export async function applyAgentEdit(input: AgentEditInput): Promise<void> {
  const { objectId, markdown, agentId, mode = "replace" } = input;
  const by = makeAuthorTag("agent", agentId);
  await runLoopbackEdit(objectId, agentId, (current) => {
    const agentJson = stampAuthor(markdownToProseMirrorJSON(markdown), by);
    if (mode !== "append") return agentJson;
    return {
      ...current,
      content: [...(current.content ?? []), ...(agentJson.content ?? [])],
    };
  });
}

// ---------------------------------------------------------------------------
// §18.1 comment + suggestion (track-changes) mark transforms
//
// These are pure ProseMirror-JSON rewrites (no Y.Doc / socket) so they are unit-
// testable and reused by the comment/suggest ops below. Every mark they add is a
// plain `{ type, attrs }` built for the ONE shared `getCollabSchema()`; the schema
// conversion (`nodeFromJSON`) happens in `runLoopbackEdit`, never against a second
// schema.
// ---------------------------------------------------------------------------

/** UUID v4-ish shape — the form `agent_identities.id` takes (defaultRandom()). */
const AGENT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A single ProseMirror-JSON mark (the element type of a text node's `marks`). */
type JSONMark = NonNullable<JSONContent["marks"]>[number];

/** Deep-copy `node`, appending `mark` to every text node. Used to stamp a whole
 *  proposed-insertion subtree as a pending suggestion. */
export function addMarkToAllTextNodes(node: JSONContent, mark: JSONMark): JSONContent {
  const walk = (n: JSONContent): JSONContent => {
    const next: JSONContent = { ...n };
    if (n.type === "text") {
      next.marks = [...(n.marks ?? []), mark];
    }
    if (Array.isArray(n.content)) {
      next.content = n.content.map(walk);
    }
    return next;
  };
  return walk(node);
}

/**
 * Anchor `mark` to the FIRST occurrence of `quote` in the document.
 *
 * The quote is located as a substring of a SINGLE text node — the common case for
 * a contiguous phrase an agent quotes. The matching text node is split into up to
 * three parts (before / matched / after); `mark` is added to the matched part only,
 * so the anchor rides that exact span through subsequent CRDT edits (a mark, not a
 * byte offset — the reason comment-mark.ts and the suggestion marks are marks). The
 * split parts keep the original node's existing marks (authorship, etc.).
 *
 * Returns the rewritten doc, or null when the quote is absent OR spans multiple
 * text nodes (e.g. crosses a bold boundary); the caller maps null to "not located".
 */
export function addMarkToQuoteSpan(
  doc: JSONContent,
  quote: string,
  mark: JSONMark
): JSONContent | null {
  if (!quote) return null;
  const state = { found: false };
  const splitFor = (textNode: JSONContent): JSONContent[] => {
    const text = textNode.text ?? "";
    const idx = text.indexOf(quote);
    const marks = textNode.marks ?? [];
    const before = text.slice(0, idx);
    const middle = text.slice(idx, idx + quote.length);
    const after = text.slice(idx + quote.length);
    const parts: JSONContent[] = [];
    if (before) parts.push({ ...textNode, text: before });
    parts.push({ ...textNode, text: middle, marks: [...marks, mark] });
    if (after) parts.push({ ...textNode, text: after });
    return parts;
  };
  const walk = (n: JSONContent): JSONContent => {
    if (state.found || !Array.isArray(n.content)) return n;
    const nextContent: JSONContent[] = [];
    for (const child of n.content) {
      if (
        !state.found &&
        child.type === "text" &&
        typeof child.text === "string" &&
        child.text.includes(quote)
      ) {
        state.found = true;
        nextContent.push(...splitFor(child));
      } else {
        nextContent.push(walk(child));
      }
    }
    return { ...n, content: nextContent };
  };
  const result = walk(doc);
  return state.found ? result : null;
}

// ---------------------------------------------------------------------------
// comment op
// ---------------------------------------------------------------------------

/**
 * The comment-thread ROOT row persisted to `atrium_doc_comments` when an agent
 * applies a `comment` op. Only the anchor (the threadId mark) lives in the Y.Doc;
 * thread bodies live in Postgres (see comment-mark.ts / atrium-doc-comments.ts).
 * A root is the row with `parent_id` NULL (the writer sets that); replies hang
 * under it and are not written here.
 *
 * - `authorAgentId` — a registered `agent_identities.id`, or null. It is set ONLY
 *   when X-Agent-Id is a UUID (a free-form label has no identity row).
 * - `authorLabel`   — the raw X-Agent-Id, always retained for attribution.
 */
export interface AgentCommentThreadRoot {
  threadId: string;
  objectId: string;
  authorAgentId: string | null;
  authorLabel: string;
  body: string;
}

/** Persists the comment-thread root row. Injectable so the smoke can stub the DB. */
export type CommentThreadRootWriter = (row: AgentCommentThreadRoot) => Promise<void>;

/**
 * Build the comment-thread root row from the op inputs. Extracted so the row
 * shape (esp. the author_agent_id-vs-label binding) is unit-testable without a DB.
 */
export function buildCommentThreadRoot(params: {
  threadId: string;
  objectId: string;
  agentId: string;
  body: string;
}): AgentCommentThreadRoot {
  return {
    threadId: params.threadId,
    objectId: params.objectId,
    authorAgentId: AGENT_UUID_RE.test(params.agentId) ? params.agentId : null,
    authorLabel: params.agentId,
    body: params.body,
  };
}

/**
 * Default writer for the comment-thread root row (#1059 §18.1). Inserts a ROOT row
 * (`parentId: null`) into the shared `atrium_doc_comments` model. `authorUserId` is
 * left null: the row attributes the comment to the AGENT (author_agent_id when the
 * identity is a registered UUID, author_label always) — the human operator is the
 * session, not the comment author.
 */
async function defaultWriteCommentThreadRoot(row: AgentCommentThreadRoot): Promise<void> {
  await executeQuery(
    (db) =>
      db.insert(atriumDocComments).values({
        threadId: row.threadId,
        objectId: row.objectId,
        parentId: null,
        body: row.body,
        authorAgentId: row.authorAgentId,
        authorLabel: row.authorLabel,
      }),
    "atrium.agentBridge.insertCommentRoot"
  );
}

export interface AgentCommentInput {
  objectId: string;
  /** agent_identities.id (or label) — the attribution stamped on the thread. */
  agentId: string;
  /** Text span to anchor the thread to (located in the live doc). */
  quote: string;
  /** The agent's comment text (screened by the route before this is called). */
  body: string;
  /** Reuse an existing thread id, else one is generated server-side. */
  threadId?: string;
  /** DI seam (tests / reconciliation). Defaults to the raw-insert writer. */
  writeThreadRoot?: CommentThreadRootWriter;
}

/**
 * Anchor an AtriumComment mark over the quoted span in the live document AND write
 * the thread root row to Postgres. The agent PROPOSES a comment on a human's text;
 * it does not rewrite content. Throws QuoteNotLocatedError if the quote is absent.
 */
export async function applyAgentComment(
  input: AgentCommentInput
): Promise<{ threadId: string }> {
  const { objectId, agentId, quote, body } = input;
  const threadId = input.threadId ?? randomUUID();
  const writeThreadRoot = input.writeThreadRoot ?? defaultWriteCommentThreadRoot;
  const mark: JSONMark = {
    type: ATRIUM_COMMENT_MARK,
    attrs: { threadId, resolved: false },
  };

  // 1. Anchor the mark in the Y.Doc (throws QuoteNotLocatedError if unmatched).
  await runLoopbackEdit(objectId, agentId, (current) => {
    const next = addMarkToQuoteSpan(current, quote, mark);
    if (!next) throw new QuoteNotLocatedError(quote);
    return next;
  });

  // 2. Persist the thread root (only after the anchor landed).
  await writeThreadRoot(buildCommentThreadRoot({ threadId, objectId, agentId, body }));

  return { threadId };
}

// ---------------------------------------------------------------------------
// suggest op (track changes)
// ---------------------------------------------------------------------------

export type SuggestionKind = "insert" | "delete";

export interface AgentSuggestionInput {
  objectId: string;
  agentId: string;
  kind: SuggestionKind;
  /** insert: proposed markdown to add (wrapped in the insert mark, not applied). */
  markdown?: string;
  /** delete: existing span to propose removing (wrapped in the delete mark; text kept). */
  quote?: string;
  /** Reuse an existing suggestion id, else one is generated server-side. */
  suggestionId?: string;
}

/**
 * Apply a PROPOSED change (track-changes), not a direct edit:
 *  - insert: append the agent's text wrapped in `atriumSuggestionInsert` so a human
 *    accepts (keep) or rejects (drop) it. The text is also authored (`ai:<agentId>`).
 *  - delete: wrap the quoted existing span in `atriumSuggestionDelete` (text is NOT
 *    removed — accepting removes it, rejecting keeps it).
 *
 * Every suggestion mark carries `by=ai:<agentId>` + `suggestionId` + `at`. Throws
 * QuoteNotLocatedError for a delete whose quote is absent.
 */
export async function applyAgentSuggestion(
  input: AgentSuggestionInput
): Promise<{ suggestionId: string }> {
  const { objectId, agentId, kind } = input;
  const suggestionId = input.suggestionId ?? randomUUID();
  const by = makeAuthorTag("agent", agentId);
  const at = new Date().toISOString();
  const attrs = { suggestionId, by, at };

  if (kind === "insert") {
    const markdown = input.markdown ?? "";
    const insertMark: JSONMark = { type: ATRIUM_SUGGESTION_INSERT_MARK, attrs };
    await runLoopbackEdit(objectId, agentId, (current) => {
      const authored = stampAuthor(markdownToProseMirrorJSON(markdown), by);
      const proposed = addMarkToAllTextNodes(authored, insertMark);
      return {
        ...current,
        content: [...(current.content ?? []), ...(proposed.content ?? [])],
      };
    });
  } else {
    const quote = input.quote ?? "";
    const deleteMark: JSONMark = { type: ATRIUM_SUGGESTION_DELETE_MARK, attrs };
    await runLoopbackEdit(objectId, agentId, (current) => {
      const next = addMarkToQuoteSpan(current, quote, deleteMark);
      if (!next) throw new QuoteNotLocatedError(quote);
      return next;
    });
  }

  return { suggestionId };
}
