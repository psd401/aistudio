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

/** Run applyAgentEdit and, on the next tick, fire `event` on the fake socket. */
async function runAndDrive(event: "close" | "error"): Promise<Error> {
  const p = applyAgentEdit({ ...input });
  // The fake socket is constructed synchronously inside applyAgentEdit; give the
  // event loop a tick, then drive the lifecycle event the test wants to assert on.
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(liveSocket, "socket was constructed");
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
  const p = applyAgentEdit({ ...input });
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(liveSocket, "socket constructed");
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
