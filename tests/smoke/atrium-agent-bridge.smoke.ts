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

const { applyAgentEdit } = await import("@/lib/content/collab/apply-agent-edit");

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

// Restore the real WebSocket.
globalThis.WebSocket = realWebSocket;

console.log(`\natrium-agent-bridge smoke: ${passed} checks passed`);
