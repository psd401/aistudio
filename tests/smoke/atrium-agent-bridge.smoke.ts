/**
 * Atrium agent-bridge failure-path smoke test (Bun)
 *
 * Issue #1051 (PR #1062 review #5). `applyAgentEdit` is the server-side agent
 * write path: it opens a raw y-sync WebSocket client to the collab server and
 * applies a markdown edit once the SyncStep2 handshake completes. The happy path
 * (a real edit landing live) is covered by the PLAYWRIGHT_AUTH_ENABLED E2E; this
 * smoke pins the FAILURE control flow that has no server in the loop:
 *   - the socket closes before SyncStep2 -> rejects ("collab websocket closed")
 *   - the socket errors                  -> rejects ("collab websocket error")
 *   - a token is minted (AUTH_SECRET wired) and the socket URL is well-formed
 *
 * Why Bun, not jest: applyAgentEdit imports markdown-bridge.ts (pure-ESM
 * TipTap/Yjs), which next/jest cannot transform. We stub globalThis.WebSocket so
 * no real network IO happens.
 *
 * Run: `bun run tests/smoke/atrium-agent-bridge.smoke.ts`
 */

import assert from "node:assert/strict";
import type { JSONContent } from "@tiptap/core";

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-collab-secret-0123456789";

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

type Listener = (ev: unknown) => void;

/**
 * A minimal fake WebSocket that records the connect URL and lets the test drive
 * lifecycle events. It NEVER emits SyncStep2, so `applied` stays false and the
 * close/error branches are exercised deterministically.
 */
class FakeWebSocket {
  static lastUrl = "";
  binaryType = "arraybuffer";
  readyState = 0;
  private listeners: Record<string, Listener[]> = {};
  constructor(url: string) {
    FakeWebSocket.lastUrl = url;
  }
  addEventListener(type: string, cb: Listener): void {
    (this.listeners[type] ??= []).push(cb);
  }
  emit(type: string, ev: unknown = {}): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
  send(): void {
    /* swallow outbound frames */
  }
  close(): void {
    this.readyState = 3;
  }
}

const realWebSocket = globalThis.WebSocket;

// Track the most recently constructed fake socket so the test can drive it.
let liveSocket: FakeWebSocket | null = null;
globalThis.WebSocket = function (url: string) {
  liveSocket = new FakeWebSocket(url);
  return liveSocket;
} as unknown as typeof WebSocket;

const {
  applyAgentEdit,
  applyAgentComment,
  applyAgentSuggestion,
  addMarkToQuoteSpan,
  addMarkToAllTextNodes,
  buildCommentThreadRoot,
} = await import("@/lib/content/collab/apply-agent-edit");
const { ATRIUM_COMMENT_MARK } = await import("@/lib/content/collab/comment-mark");
const { ATRIUM_SUGGESTION_INSERT_MARK, ATRIUM_SUGGESTION_DELETE_MARK } = await import(
  "@/lib/content/collab/suggestion-marks"
);

const input = {
  objectId: "11111111-1111-1111-1111-111111111111",
  markdown: "# Draft\n\nagent text",
  agentId: "bot-1",
} as const;

/**
 * Wait until applyAgentEdit has constructed THIS call's fake socket.
 *
 * applyAgentEdit `await`s async token signing (crypto.subtle) BEFORE it
 * constructs the WebSocket, so the socket is NOT guaranteed to exist after a
 * single macrotask — on a slower runtime (CI/Bun-on-Linux) signing can take
 * longer than one `setTimeout(0)`. The earlier harness read the module-level
 * `liveSocket` after exactly one tick without resetting it, so a slow second
 * call drove the PREVIOUS (already-settled) socket — a no-op — and the real
 * socket then hit the 10s SYNC_TIMEOUT, surfacing as a flaky `'collab sync
 * timeout'` in CI. Reset + poll removes the race deterministically.
 */
async function waitForSocket(): Promise<void> {
  for (let i = 0; i < 200 && !liveSocket; i += 1) {
    await new Promise((r) => setTimeout(r, 5)); // ≤1s cap, well under SYNC_TIMEOUT
  }
  assert.ok(liveSocket, "socket was constructed");
}

/** Run applyAgentEdit and, once its socket exists, fire `event` on it. */
async function runAndDrive(event: "close" | "error"): Promise<Error> {
  liveSocket = null; // clear any socket left over from a previous check
  const p = applyAgentEdit({ ...input });
  // Drive THIS call's socket — not a stale one — once token signing has resolved
  // and the socket is constructed.
  await waitForSocket();
  liveSocket!.emit(event);
  try {
    await p;
    throw new Error("expected applyAgentEdit to reject");
  } catch (e) {
    return e as Error;
  }
}

await check("rejects when the socket closes before SyncStep2", async () => {
  const err = await runAndDrive("close");
  assert.match(err.message, /closed/i);
});

await check("rejects when the socket errors", async () => {
  const err = await runAndDrive("error");
  assert.match(err.message, /error/i);
});

await check("connects to the collab WS path with a token query param", async () => {
  liveSocket = null;
  const p = applyAgentEdit({ ...input });
  await waitForSocket();
  assert.match(FakeWebSocket.lastUrl, /\/api\/atrium-collab\//);
  assert.match(FakeWebSocket.lastUrl, /[?&]token=/);
  assert.ok(
    FakeWebSocket.lastUrl.includes(input.objectId),
    "URL targets the object room"
  );
  liveSocket!.emit("close"); // settle the pending promise
  await p.catch(() => undefined);
});

// ---------------------------------------------------------------------------
// §18.1 comment + suggestion (track-changes) op coverage
//
// The mark transforms are pure ProseMirror-JSON rewrites (no socket/DB), so the
// "Y.Doc mark application" is asserted directly on them — this is exactly the JSON
// that runLoopbackEdit converts (via the one shared schema) and diffs into the doc.
// The DB thread-row write is asserted on `buildCommentThreadRoot` (the row payload)
// so no DB is required. Loopback wiring for the two new ops reuses the fake socket.
// ---------------------------------------------------------------------------

function docText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  return (node.content ?? []).map(docText).join("");
}

function findTextWithMark(node: JSONContent, markType: string): JSONContent | null {
  if (node.type === "text" && (node.marks ?? []).some((m) => m.type === markType)) {
    return node;
  }
  for (const child of node.content ?? []) {
    const hit = findTextWithMark(child, markType);
    if (hit) return hit;
  }
  return null;
}

const sampleDoc: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "The quick brown fox jumps." }],
    },
  ],
};

await check("comment op anchors the comment mark over the quoted span", async () => {
  const mark = { type: ATRIUM_COMMENT_MARK, attrs: { threadId: "t-1", resolved: false } };
  const next = addMarkToQuoteSpan(sampleDoc, "quick brown", mark);
  assert.ok(next, "quote located");
  // Text is preserved verbatim (the span was split, not rewritten).
  assert.equal(docText(next!), "The quick brown fox jumps.");
  const marked = findTextWithMark(next!, ATRIUM_COMMENT_MARK);
  assert.ok(marked, "a text node carries the comment mark");
  assert.equal(marked!.text, "quick brown");
  assert.equal(
    (marked!.marks ?? []).find((m) => m.type === ATRIUM_COMMENT_MARK)?.attrs?.threadId,
    "t-1"
  );
});

await check("comment op returns null (not located) when the quote is absent", async () => {
  const mark = { type: ATRIUM_COMMENT_MARK, attrs: { threadId: "t-2", resolved: false } };
  assert.equal(addMarkToQuoteSpan(sampleDoc, "no such phrase", mark), null);
});

await check("comment thread root binds author_agent_id only for a UUID identity", async () => {
  const labelRow = buildCommentThreadRoot({
    threadId: "11111111-1111-1111-1111-111111111111",
    objectId: input.objectId,
    agentId: "bot-1",
    body: "needs a citation",
  });
  assert.equal(labelRow.authorAgentId, null, "free-form label => no identity row");
  assert.equal(labelRow.authorLabel, "bot-1");
  assert.equal(labelRow.body, "needs a citation");

  const uuid = "22222222-2222-2222-2222-222222222222";
  const uuidRow = buildCommentThreadRoot({
    threadId: "33333333-3333-3333-3333-333333333333",
    objectId: input.objectId,
    agentId: uuid,
    body: "ok",
  });
  assert.equal(uuidRow.authorAgentId, uuid, "UUID id binds to agent_identities");
});

await check("suggest:insert wraps proposed text in the insert mark (not a rewrite)", async () => {
  const proposed: JSONContent = {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "add this" }] }],
  };
  const insertMark = {
    type: ATRIUM_SUGGESTION_INSERT_MARK,
    attrs: { suggestionId: "s-1", by: "ai:bot-1", at: "2026-07-05T00:00:00Z" },
  };
  const wrapped = addMarkToAllTextNodes(proposed, insertMark);
  assert.equal(docText(wrapped), "add this", "text is unchanged, only marked");
  const marked = findTextWithMark(wrapped, ATRIUM_SUGGESTION_INSERT_MARK);
  assert.ok(marked, "proposed text carries the insert mark");
  assert.equal(
    (marked!.marks ?? []).find((m) => m.type === ATRIUM_SUGGESTION_INSERT_MARK)?.attrs?.by,
    "ai:bot-1"
  );
});

await check("suggest:delete marks the span for deletion without removing text", async () => {
  const deleteMark = {
    type: ATRIUM_SUGGESTION_DELETE_MARK,
    attrs: { suggestionId: "s-2", by: "ai:bot-1", at: "2026-07-05T00:00:00Z" },
  };
  const next = addMarkToQuoteSpan(sampleDoc, "fox", deleteMark);
  assert.ok(next, "quote located");
  // Pending deletions keep the text (accepting later removes it).
  assert.equal(docText(next!), "The quick brown fox jumps.");
  const marked = findTextWithMark(next!, ATRIUM_SUGGESTION_DELETE_MARK);
  assert.ok(marked, "the span carries the delete mark");
  assert.equal(marked!.text, "fox");
});

/** Drive an op's loopback socket to close so the pending promise settles. */
async function driveLoopback(p: Promise<unknown>): Promise<void> {
  await waitForSocket();
  assert.match(FakeWebSocket.lastUrl, /\/api\/atrium-collab\//);
  assert.ok(FakeWebSocket.lastUrl.includes(input.objectId), "URL targets the object room");
  liveSocket!.emit("close");
  await p.catch(() => undefined);
}

await check("comment op routes through the collab loopback client", async () => {
  liveSocket = null;
  let wroteRow = false;
  const p = applyAgentComment({
    objectId: input.objectId,
    agentId: "bot-1",
    quote: "quick brown",
    body: "note",
    // Stub the DB seam so the smoke needs no database.
    writeThreadRoot: async () => {
      wroteRow = true;
    },
  });
  await driveLoopback(p);
  // The socket closes before SyncStep2, so the anchor never lands and the row is
  // never written — the stub simply proves the seam is injectable/DB-free here.
  assert.equal(wroteRow, false);
});

await check("suggest:insert op routes through the collab loopback client", async () => {
  liveSocket = null;
  const p = applyAgentSuggestion({
    objectId: input.objectId,
    agentId: "bot-1",
    kind: "insert",
    markdown: "proposed text",
  });
  await driveLoopback(p);
});

await check("suggest:delete op routes through the collab loopback client", async () => {
  liveSocket = null;
  const p = applyAgentSuggestion({
    objectId: input.objectId,
    agentId: "bot-1",
    kind: "delete",
    quote: "fox",
  });
  await driveLoopback(p);
});

// Restore the real WebSocket.
globalThis.WebSocket = realWebSocket;

console.log(`\natrium-agent-bridge smoke: ${passed} checks passed`);
