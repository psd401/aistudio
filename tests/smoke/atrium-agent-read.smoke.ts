/**
 * Atrium agent-read round-trip smoke test (Bun)
 *
 * Issue #1087 (Nexus workspace chat reads/edits the live Atrium doc). Pins the
 * READ path added alongside the agent write bridge:
 *   markdown -> seeded Y.Doc -> [live y-sync read] -> proseMirrorJSONToMarkdown.
 *
 * `readAgentDocMarkdown` opens a READ-ONLY y-sync client to the collab server and
 * serializes the hydrated doc back to markdown. Here a fake WebSocket plays the
 * server: it answers the client's SyncStep1 with a REAL SyncStep2 built from a
 * doc seeded via the production `seedYDocFromMarkdown`, so the whole hydrate +
 * serialize round-trip runs with no network or database. The FAILURE path (socket
 * closes before hydration -> `null`) is pinned too.
 *
 * Why Bun, not jest: readAgentDocMarkdown imports markdown-bridge.ts (pure-ESM
 * TipTap/Yjs), which next/jest cannot transform. (The pure serializer itself has
 * jest coverage in tests/unit/lib/content/collab/prosemirror-markdown.test.ts.)
 *
 * Run: `bun run tests/smoke/atrium-agent-read.smoke.ts`
 */

import assert from "node:assert/strict";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-collab-secret-0123456789";

const MESSAGE_SYNC = 0;
const SYNC_STEP_1 = 0;

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

type Listener = (ev: unknown) => void;

// Per-test server behavior. `serverDoc` is the doc the fake "server" hydrates the
// client from; `mode` selects the round-trip vs failure control flow.
const server: { doc: Y.Doc | null; mode: "hydrate" | "close" } = { doc: null, mode: "hydrate" };

/**
 * A fake WebSocket that plays the collab server: on the client's SyncStep1 it
 * replies with the SyncStep2 the REAL server would compute from `server.doc` (via
 * the same y-protocols `readSyncMessage`). In "close" mode it never replies and
 * closes, so readAgentDocMarkdown's failure path is exercised.
 */
class FakeWebSocket {
  static lastUrl = "";
  binaryType = "arraybuffer";
  readyState = 0;
  private listeners: Record<string, Listener[]> = {};
  constructor(url: string) {
    FakeWebSocket.lastUrl = url;
    // Fire 'open' after the caller has attached its listeners (next macrotask).
    setTimeout(() => {
      this.readyState = 1;
      this.emit("open");
      if (server.mode === "close") {
        setTimeout(() => this.emit("close"), 0);
      }
    }, 0);
  }
  addEventListener(type: string, cb: Listener): void {
    (this.listeners[type] ??= []).push(cb);
  }
  emit(type: string, ev: unknown = {}): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
  send(data: ArrayBufferView): void {
    if (server.mode !== "hydrate" || !server.doc) return;
    const u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const decoder = decoding.createDecoder(u8);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;
    // Peek the sync sub-type: only reply to the client's SyncStep1 with SyncStep2.
    const peek = decoding.createDecoder(u8);
    decoding.readVarUint(peek);
    if (decoding.readVarUint(peek) !== SYNC_STEP_1) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    // readSyncMessage reads the client's SyncStep1 (its state vector) and writes
    // the SyncStep2 diff of `server.doc` into `enc` — exactly the server reply.
    syncProtocol.readSyncMessage(decoder, enc, server.doc, this);
    if (encoding.length(enc) > 1) {
      const frame = encoding.toUint8Array(enc).slice(); // exact-length copy
      queueMicrotask(() => this.emit("message", { data: frame.buffer }));
    }
  }
  close(): void {
    this.readyState = 3;
  }
}

const realWebSocket = globalThis.WebSocket;
globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
(globalThis.WebSocket as unknown as { OPEN: number }).OPEN = 1;

// Import AFTER the WebSocket stub is installed so readAgentDocMarkdown's socket is fake.
const { seedYDocFromMarkdown, yDocToProseMirrorJSON } = await import(
  "@/lib/content/collab/markdown-bridge"
);
const { readAgentDocMarkdown } = await import("@/lib/content/collab/apply-agent-edit");
const { proseMirrorJSONToMarkdown } = await import(
  "@/lib/content/collab/prosemirror-markdown"
);

const OID = "11111111-1111-1111-1111-111111111111";

// --- Pure round-trip: a seeded Y.Doc serializes back to equivalent markdown. ---

await check("seeded Y.Doc -> ProseMirror JSON -> markdown preserves content", async () => {
  const md = "# Title\n\nHello **world** and _emphasis_.";
  const seeded = seedYDocFromMarkdown(md, "human:7");
  const out = proseMirrorJSONToMarkdown(yDocToProseMirrorJSON(seeded));
  assert.equal(out, "# Title\n\nHello **world** and _emphasis_.");
});

await check("an empty seeded doc serializes to '' (new / title-only document)", async () => {
  const seeded = seedYDocFromMarkdown("", "human:7");
  const out = proseMirrorJSONToMarkdown(yDocToProseMirrorJSON(seeded));
  assert.equal(out, "");
});

// --- Live read: readAgentDocMarkdown hydrates from the fake server + serializes. ---

await check("readAgentDocMarkdown round-trips markdown from the live server doc", async () => {
  server.mode = "hydrate";
  server.doc = seedYDocFromMarkdown("# Live\n\nfresh content here", "ai:bot-1");
  const out = await readAgentDocMarkdown(OID);
  assert.equal(out, "# Live\n\nfresh content here");
});

await check("readAgentDocMarkdown reads structured content (list + heading)", async () => {
  server.mode = "hydrate";
  server.doc = seedYDocFromMarkdown("## Steps\n\n- first\n- second", "human:7");
  const out = await readAgentDocMarkdown(OID);
  assert.equal(out, "## Steps\n\n- first\n- second");
});

await check("readAgentDocMarkdown returns '' for an empty live document", async () => {
  server.mode = "hydrate";
  server.doc = seedYDocFromMarkdown("", "human:7");
  const out = await readAgentDocMarkdown(OID);
  assert.equal(out, "");
});

await check("readAgentDocMarkdown connects READ-ONLY to the collab room with a token", async () => {
  server.mode = "hydrate";
  server.doc = seedYDocFromMarkdown("body", "human:7");
  await readAgentDocMarkdown(OID);
  assert.match(FakeWebSocket.lastUrl, /\/api\/atrium-collab\//);
  assert.match(FakeWebSocket.lastUrl, /[?&]token=/);
  assert.ok(FakeWebSocket.lastUrl.includes(OID), "URL targets the object room");
});

await check("readAgentDocMarkdown returns null when the socket closes before hydration", async () => {
  server.mode = "close";
  server.doc = null;
  const out = await readAgentDocMarkdown(OID);
  assert.equal(out, null);
});

globalThis.WebSocket = realWebSocket;

console.log(`\natrium-agent-read smoke: ${passed} checks passed`);
