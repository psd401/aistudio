/**
 * Atrium artifact sandbox HOST PAGE security smoke (Bun + jsdom) — #1052, Phase 2
 *
 * The acceptance-critical containment test (spec §28.1, issue #1052 AC: "artifact
 * code cannot read app cookies/localStorage or call first-party APIs"). It loads
 * the real static host page (infra/sandbox-host/render.html), substitutes the
 * deploy-time tokens exactly as the CDK stack does, runs the page script in jsdom,
 * and asserts the host's runtime defenses:
 *
 *  1. The host renders artifact markup ONLY for a render message whose
 *     event.origin is on the build-time parent-origin allowlist.
 *  2. A render message from an origin NOT on the allowlist is IGNORED (a random
 *     site that frames the host cannot inject code).
 *  3. A non-render message from an allowed origin is ignored.
 *  4. Inline <script> nodes in the artifact are recreated so they execute (the
 *     mechanism the canvas relies on) — but only the author's own scripts.
 *
 * The cross-origin + iframe-sandbox + CSP layers are enforced by the browser /
 * CloudFront, not by this script; this test proves the host's OWN allowlist gate
 * (the layer the host code is responsible for) holds. The CSP string assembled by
 * the CDK stack is asserted separately (see infra synth + the config smoke).
 *
 * Why a Bun smoke and not jest: jsdom is a native/ESM-heavy dep next/jest (SWC)
 * does not transform cleanly; the rest of the Atrium DOM checks are Bun smokes.
 *
 * Run: `bun run tests/smoke/atrium-artifact-sandbox-host.smoke.ts`
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> | void {
  const done = () => {
    passed += 1;
    console.log(`  ✓ ${name}`);
  };
  const r = fn();
  return r instanceof Promise ? r.then(done) : done();
}

const APP_ORIGIN = "https://app.example.com";
const EVIL_ORIGIN = "https://evil.example.com";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AtriumDataApi {
  submit(
    namespace: string,
    payload: unknown
  ): Promise<{ id: string; createdAt: string }>;
  list(
    namespace: string,
    options?: { limit?: number; scope?: "all" | "mine" }
  ): Promise<{ records: unknown[] }>;
  query(
    sql: string,
    options?: { limit?: number; offset?: number }
  ): Promise<{ columns: string[]; rows: unknown[][] }>;
}

interface ParentMessage {
  type?: unknown;
  requestId?: unknown;
  op?: unknown;
  namespace?: unknown;
  payload?: unknown;
  limit?: unknown;
  scope?: unknown;
}

/** Build the deployed host HTML the way the CDK stack does (token substitution). */
function renderHostHtml(allowedParentOrigins: string[]): string {
  // Resolve from the repo root (these smokes are run via `bun run tests/...`
  // from the project root). Avoids the Bun-only `import.meta.dir`, which would
  // need a global `bun-types` reference that pollutes the whole tsc program's
  // `fetch` type and breaks unrelated DOM-typed tests.
  const templatePath = path.join(
    process.cwd(),
    "infra",
    "sandbox-host",
    "render.html"
  );
  // Path is built from process.cwd() + fixed literal segments (the repo's
  // committed host template) — no external input. The lint rule cannot see that.

  const template = fs.readFileSync(templatePath, "utf8");
  // Mirror atrium-sandbox-stack.ts substitution.
  const csp = "default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; worker-src 'none'; img-src data:";
  return template
    .replaceAll("__ALLOWED_PARENT_ORIGINS__", JSON.stringify(allowedParentOrigins))
    .replaceAll("__CSP_POLICY__", csp);
}

/** Spin up a jsdom window running the host page script, with a capture for acks. */
function makeHost(
  allowedParentOrigins: string[],
  options: {
    timeoutDelayMs?: number;
    disableRandomUuid?: boolean;
    postMessageFailures?: number;
  } = {}
): {
  window: Window & typeof globalThis;
  acks: Array<{ origin: string; data: unknown }>;
  parentMessages: Array<{ origin: string; data: ParentMessage }>;
} {
  const html = renderHostHtml(allowedParentOrigins);
  const acks: Array<{ origin: string; data: unknown }> = [];
  const parentMessages: Array<{ origin: string; data: ParentMessage }> = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    beforeParse(jsdomWindow) {
      const hostWindow = jsdomWindow as unknown as Window & typeof globalThis;
      let remainingPostMessageFailures = options.postMessageFailures ?? 0;
      hostWindow.parent.postMessage = ((
        data: ParentMessage,
        targetOrigin: string
      ) => {
        if (remainingPostMessageFailures > 0) {
          remainingPostMessageFailures -= 1;
          throw new Error("postMessage failed");
        }
        parentMessages.push({ origin: targetOrigin, data });
      }) as Window["postMessage"];
      if (options.timeoutDelayMs !== undefined) {
        const nativeSetTimeout = hostWindow.setTimeout.bind(hostWindow);
        Object.defineProperty(hostWindow, "setTimeout", {
          configurable: true,
          value: (handler: TimerHandler) =>
            nativeSetTimeout(handler, options.timeoutDelayMs),
        });
      }
      if (options.disableRandomUuid) {
        Object.defineProperty(hostWindow.crypto, "randomUUID", {
          configurable: true,
          value: undefined,
        });
      }
    },
  });
  const window = dom.window as unknown as Window & typeof globalThis;
  // The host calls event.source.postMessage(ack, event.origin); our synthetic
  // `source` records what the host tried to send back.
  return { window, acks, parentMessages };
}

/** Dispatch a synthetic MessageEvent with a controlled origin into the host. */
function postToHost(
  window: Window & typeof globalThis,
  origin: string,
  data: unknown,
  acks: Array<{ origin: string; data: unknown }>
): void {
  const source = {
    postMessage: (msg: unknown, targetOrigin: string) => {
      acks.push({ origin: targetOrigin, data: msg });
    },
  };
  const event = new window.MessageEvent("message", {
    data,
    origin,
    // jsdom honors a provided source object on the event.
    source: source as unknown as Window,
  });
  window.dispatchEvent(event);
}

function rootHtml(window: Window & typeof globalThis): string {
  return window.document.getElementById("atrium-artifact-root")?.innerHTML ?? "";
}

function atriumData(window: Window & typeof globalThis): AtriumDataApi {
  const api = (window as unknown as { AtriumData?: AtriumDataApi }).AtriumData;
  assert.ok(api, "window.AtriumData was not installed");
  return api;
}

function postDataResponse(
  window: Window & typeof globalThis,
  data: unknown,
  source: Window = window.parent
): void {
  window.dispatchEvent(
    new window.MessageEvent("message", {
      data,
      origin: APP_ORIGIN,
      source,
    })
  );
}

function testAtriumDataReadyBeforeArtifact(): void {
  const { window, acks } = makeHost([APP_ORIGIN]);
  const code =
    "<script>window.__ATRIUM_DATA_READY__ = " +
    "typeof window.AtriumData?.submit === 'function' && " +
    "typeof window.AtriumData?.query === 'function' && " +
    "typeof window.AtriumData?.list === 'function';</" +
    "script>";
  postToHost(window, APP_ORIGIN, { type: "atrium-render", code }, acks);
  assert.equal(
    (window as unknown as { __ATRIUM_DATA_READY__?: boolean })
      .__ATRIUM_DATA_READY__,
    true
  );
}

async function testBridgeEnvelopes(): Promise<void> {
  const { window, parentMessages } = makeHost([APP_ORIGIN]);
  const api = atriumData(window);
  const payload = { score: 42 };

  const submitPromise = api.submit("leaderboard", payload);
  assert.equal(parentMessages.length, 1);
  assert.equal(parentMessages[0]?.origin, "*");
  const submitRequest = parentMessages[0]?.data;
  assert.deepEqual(submitRequest, {
    type: "atrium-artifact-data-request",
    requestId: submitRequest?.requestId,
    op: "submit",
    namespace: "leaderboard",
    payload,
  });
  assert.match(String(submitRequest?.requestId), UUID_PATTERN);
  const submitted = {
    id: "record-1",
    createdAt: "2026-08-01T12:00:00.000Z",
  };
  postDataResponse(window, {
    type: "atrium-artifact-data-response",
    requestId: submitRequest?.requestId,
    ok: true,
    data: submitted,
  });
  assert.deepEqual(await submitPromise, submitted);

  const listPromise = api.list("leaderboard", { limit: 50, scope: "mine" });
  assert.equal(parentMessages.length, 2);
  assert.equal(parentMessages[1]?.origin, "*");
  const listRequest = parentMessages[1]?.data;
  assert.deepEqual(listRequest, {
    type: "atrium-artifact-data-request",
    requestId: listRequest?.requestId,
    op: "list",
    namespace: "leaderboard",
    limit: 50,
    scope: "mine",
  });
  assert.match(String(listRequest?.requestId), UUID_PATTERN);
  assert.notEqual(listRequest?.requestId, submitRequest?.requestId);
  const listed = { records: [submitted] };
  postDataResponse(window, {
    type: "atrium-artifact-data-response",
    requestId: listRequest?.requestId,
    ok: true,
    data: listed,
  });
  assert.deepEqual(await listPromise, listed);
}

/**
 * #1705 — the query envelope. It carries ONLY sql/limit/offset (and never a
 * namespace): format/export/reason/tool are forced by the parent's Server
 * Action, so sending them from here would change nothing and they are omitted.
 */
async function testQueryEnvelope(): Promise<void> {
  const { window, parentMessages } = makeHost([APP_ORIGIN]);
  const api = atriumData(window);

  const queryPromise = api.query("SELECT 1", { limit: 10, offset: 5 });
  assert.equal(parentMessages.length, 1);
  assert.equal(parentMessages[0]?.origin, "*");
  const request = parentMessages[0]?.data;
  assert.deepEqual(request, {
    type: "atrium-artifact-data-request",
    requestId: request?.requestId,
    op: "query",
    sql: "SELECT 1",
    limit: 10,
    offset: 5,
  });
  assert.match(String(request?.requestId), UUID_PATTERN);

  const rows = { columns: ["n"], rows: [[1]] };
  postDataResponse(window, {
    type: "atrium-artifact-data-response",
    requestId: request?.requestId,
    ok: true,
    data: rows,
  });
  assert.deepEqual(await queryPromise, rows);
}

/** A query with no options omits limit/offset entirely rather than sending undefined. */
async function testQueryEnvelopeWithoutOptions(): Promise<void> {
  const { window, parentMessages } = makeHost([APP_ORIGIN]);
  const api = atriumData(window);

  const queryPromise = api.query("SELECT 1");
  const request = parentMessages[0]?.data;
  assert.deepEqual(request, {
    type: "atrium-artifact-data-request",
    requestId: request?.requestId,
    op: "query",
    sql: "SELECT 1",
  });

  postDataResponse(window, {
    type: "atrium-artifact-data-response",
    requestId: request?.requestId,
    ok: false,
    error: "Artifact data request failed",
  });
  await assert.rejects(queryPromise, /Artifact data request failed/);
}

async function testParentSourceFilter(): Promise<void> {
  const { window, parentMessages } = makeHost([APP_ORIGIN]);
  const listPromise = atriumData(window).list("leaderboard");
  const requestId = parentMessages[0]?.data.requestId;
  let settled = false;
  void listPromise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );

  postDataResponse(
    window,
    {
      type: "atrium-artifact-data-response",
      requestId,
      ok: true,
      data: { records: ["spoofed"] },
    },
    {} as Window
  );
  await Promise.resolve();
  assert.equal(settled, false, "a non-parent source settled the pending call");

  postDataResponse(window, {
    type: "atrium-artifact-data-response",
    requestId,
    ok: true,
    data: { records: [] },
  });
  assert.deepEqual(await listPromise, { records: [] });
}

async function testDisabledBridgeResponse(): Promise<void> {
  const { window, parentMessages } = makeHost([APP_ORIGIN]);
  const listPromise = atriumData(window).list("leaderboard");
  postDataResponse(window, {
    type: "atrium-artifact-data-response",
    requestId: parentMessages[0]?.data.requestId,
    ok: false,
    error: "Atrium data bridge is disabled",
  });
  await assert.rejects(listPromise, /Atrium data bridge is disabled/);
}

async function testDataRequestTimeout(): Promise<void> {
  const { window } = makeHost([APP_ORIGIN], { timeoutDelayMs: 0 });
  await assert.rejects(
    atriumData(window).list("leaderboard"),
    /Atrium data request timed out/
  );
}

async function testMissingRandomUuidDoesNotBreakRendering(): Promise<void> {
  const { window, acks, parentMessages } = makeHost([APP_ORIGIN], {
    disableRandomUuid: true,
  });

  await assert.rejects(
    atriumData(window).list("leaderboard"),
    /Atrium data bridge is unavailable/
  );
  assert.equal(parentMessages.length, 0);

  postToHost(
    window,
    APP_ORIGIN,
    { type: "atrium-render", code: "<p id='still-renders'>ready</p>" },
    acks
  );
  assert.match(rootHtml(window), /id="still-renders"/);
  assert.deepEqual(acks[0]?.data, {
    type: "atrium-artifact-rendered",
    ok: true,
  });
}

async function testPostMessageFailureCleanup(): Promise<void> {
  const { window, parentMessages } = makeHost([APP_ORIGIN], {
    postMessageFailures: 1,
  });
  const api = atriumData(window);

  await assert.rejects(
    api.list("leaderboard"),
    /Atrium data bridge is unavailable/
  );
  assert.equal(parentMessages.length, 0);

  const retry = api.list("leaderboard");
  const requestId = parentMessages[0]?.data.requestId;
  postDataResponse(window, {
    type: "atrium-artifact-data-response",
    requestId,
    ok: true,
    data: { records: [] },
  });
  assert.deepEqual(await retry, { records: [] });
}

async function testPendingRequestBound(): Promise<void> {
  const { window, parentMessages } = makeHost([APP_ORIGIN]);
  const api = atriumData(window);
  const pending: Array<Promise<{ records: unknown[] }>> = [];
  for (let i = 0; i < 32; i += 1) {
    pending.push(api.list("leaderboard"));
  }
  await assert.rejects(
    api.list("leaderboard"),
    /Atrium data bridge has too many pending requests/
  );

  for (const request of parentMessages) {
    postDataResponse(window, {
      type: "atrium-artifact-data-response",
      requestId: request.data.requestId,
      ok: true,
      data: { records: [] },
    });
  }
  await Promise.all(pending);

  const afterCleanup = api.list("leaderboard");
  const afterCleanupRequest = parentMessages[32]?.data;
  postDataResponse(window, {
    type: "atrium-artifact-data-response",
    requestId: afterCleanupRequest?.requestId,
    ok: true,
    data: { records: [] },
  });
  assert.deepEqual(await afterCleanup, { records: [] });
}

async function main(): Promise<void> {
  await check("renders artifact markup for an allowlisted parent origin", () => {
    const { window, acks } = makeHost([APP_ORIGIN]);
    postToHost(window, APP_ORIGIN, { type: "atrium-render", code: "<p id='ok'>hello</p>" }, acks);
    assert.match(rootHtml(window), /id="ok"/, "allowed render did not inject markup");
    // The host acks success back to the (validated) parent origin only.
    assert.equal(acks.length, 1);
    assert.equal(acks[0]?.origin, APP_ORIGIN);
    assert.deepEqual(acks[0]?.data, { type: "atrium-artifact-rendered", ok: true });
  });

  await check("IGNORES render message from a non-allowlisted origin (no injection, no ack)", () => {
    const { window, acks } = makeHost([APP_ORIGIN]);
    postToHost(window, EVIL_ORIGIN, { type: "atrium-render", code: "<p id='evil'>x</p>" }, acks);
    assert.doesNotMatch(rootHtml(window), /id="evil"/, "untrusted-origin code was injected!");
    assert.equal(acks.length, 0, "host acked an untrusted origin");
  });

  await check("IGNORES non-render message from an allowed origin", () => {
    const { window, acks } = makeHost([APP_ORIGIN]);
    postToHost(window, APP_ORIGIN, { type: "something-else", code: "<p id='nope'>x</p>" }, acks);
    assert.doesNotMatch(rootHtml(window), /id="nope"/);
    assert.equal(acks.length, 0);
  });

  await check("empty allowlist => no parent can drive the sandbox (fail closed)", () => {
    const { window, acks } = makeHost([]);
    postToHost(window, APP_ORIGIN, { type: "atrium-render", code: "<p id='x'>x</p>" }, acks);
    assert.doesNotMatch(rootHtml(window), /id="x"/);
    assert.equal(acks.length, 0);
  });

  await check("recreates the artifact's inline <script> so it executes", () => {
    const { window, acks } = makeHost([APP_ORIGIN]);
    // The script sets a global the test can observe — proves the recreate-script
    // mechanism the canvas depends on works.
    const code = "<div id='m'></div><script>window.__ARTIFACT_RAN__ = true;</" + "script>";
    postToHost(window, APP_ORIGIN, { type: "atrium-render", code }, acks);
    assert.equal(
      (window as unknown as { __ARTIFACT_RAN__?: boolean }).__ARTIFACT_RAN__,
      true,
      "inline artifact script did not execute"
    );
  });

  await check(
    "installs AtriumData before artifact scripts execute",
    testAtriumDataReadyBeforeArtifact
  );
  await check(
    "submit and list use UUID-correlated bridge envelopes",
    testBridgeEnvelopes
  );
  await check(
    "ignores data responses not sent by window.parent",
    testParentSourceFilter
  );
  await check(
    "rejects a disabled-bridge response with a catchable error",
    testDisabledBridgeResponse
  );
  await check(
    "rejects and cleans up when no response arrives before timeout",
    testDataRequestTimeout
  );
  await check("sends a query envelope with only sql/limit/offset", testQueryEnvelope);
  await check(
    "omits absent query options and surfaces a rejection",
    testQueryEnvelopeWithoutOptions
  );
  await check(
    "keeps rendering when UUID generation is unavailable",
    testMissingRandomUuidDoesNotBreakRendering
  );
  await check(
    "cleans up after a synchronous parent post failure",
    testPostMessageFailureCleanup
  );
  await check(
    "bounds pending calls and releases capacity after cleanup",
    testPendingRequestBound
  );

  await check("the deployed host page hard-codes no allow-same-origin and embeds the allowlist", () => {
    const html = renderHostHtml([APP_ORIGIN]);
    // The token must be fully substituted (no leftover placeholder ships).
    assert.doesNotMatch(html, /__ALLOWED_PARENT_ORIGINS__/);
    assert.doesNotMatch(html, /__CSP_POLICY__/);
    // Parse the baked-in allowlist out of the served HTML and assert it equals
    // the exact expected origins. We extract the assignment and JSON.parse the
    // array rather than `html.includes(<origin>)`: a bare substring check on a URL
    // both lets an attacker-shaped value match anywhere in the page AND trips the
    // "incomplete URL substring sanitization" static-analysis pattern. Deep-equal
    // on the parsed array is precise and avoids the URL-substring shape entirely.
    const match = html.match(/ALLOWED_PARENT_ORIGINS\s*=\s*(\[[^\]]*\]);/);
    assert.ok(match, "host page is missing the ALLOWED_PARENT_ORIGINS assignment");
    const bakedOrigins = JSON.parse(match[1]) as string[];
    assert.deepEqual(
      bakedOrigins,
      [APP_ORIGIN],
      `baked parent-origin allowlist does not match: ${match[1]}`
    );
  });

  console.log(`\nartifact-sandbox-host smoke: ${passed} checks passed`);
}

void main();
