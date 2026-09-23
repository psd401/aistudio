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
 *  5. (#1785) Those scripts run in DOCUMENT ORDER — an inline script waits for a
 *     preceding external/module script — and the host fires a synthetic
 *     DOMContentLoaded + load exactly once after the last one, so artifacts that
 *     bootstrap from those events are not left blank.
 *
 * NOTE on (5): jsdom serializes dynamically inserted scripts on its own, so it
 * cannot reproduce the real-browser force-async interleave the fix targets. What
 * it CAN pin is the host's observable contract — ordering, the lifecycle events,
 * and that a failed/never-answering/non-executable script never stalls the chain.
 * The browser-semantics proof lives in
 * `tests/e2e/atrium-sandbox-script-order.spec.ts`, which runs the real host page
 * in Chromium.
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
import * as jsdomModule from "jsdom";
import { JSDOM, VirtualConsole, type ConstructorOptions } from "jsdom";

/**
 * jsdom still EXPORTS `ResourceLoader` at runtime, but @types/jsdom 28 dropped
 * the declaration when jsdom 26 moved subresource control to undici dispatchers.
 * Subclassing the loader is still the smallest way to serve a stubbed script
 * body with no network, so it is reached through a narrow local type rather than
 * pulling undici mocking into a smoke.
 */
interface JsdomResourceLoader {
  fetch(url: string, options?: unknown): Promise<Buffer> | null;
}
const ResourceLoader = (
  jsdomModule as unknown as { ResourceLoader: new () => JsdomResourceLoader }
).ResourceLoader;

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
const SANDBOX_ORIGIN = "https://sandbox.example.com";
/** The cdnjs pattern #1750's allowlist makes reachable (and #1785 broke). */
const CHART_CDN_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js";
const CHART_STUB_SOURCE = "window.Chart = function Chart() {};";
/** Close the inline `</script>` so this file is not itself misparsed anywhere. */
const CLOSE_SCRIPT = "</" + "script>";
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

/** How a stubbed external `<script src>` resolves. */
type StubScript = { kind: "ok"; source: string } | { kind: "error" };

/**
 * Serves stubbed sources for the exact `src` URLs a test declares, so the
 * external-script path is exercised with no network. Any other URL returns
 * null, which is jsdom's "do not load this resource".
 */
class StubScriptLoader extends ResourceLoader {
  constructor(private readonly scripts: Record<string, StubScript>) {
    super();
  }

  fetch(url: string): Promise<Buffer> | null {
    const stub = this.scripts[url];
    if (!stub) return null;
    const promise =
      stub.kind === "error"
        ? Promise.reject<Buffer>(new Error("stubbed load failure"))
        : Promise.resolve(Buffer.from(stub.source, "utf8"));
    // jsdom's loader contract wants an abortable promise; nothing in these
    // tests aborts, so a no-op abort satisfies it.
    return Object.assign(promise, { abort: () => {} });
  }
}

/** Spin up a jsdom window running the host page script, with a capture for acks. */
function makeHost(
  allowedParentOrigins: string[],
  options: {
    timeoutDelayMs?: number;
    disableRandomUuid?: boolean;
    postMessageFailures?: number;
    externalScripts?: Record<string, StubScript>;
  } = {}
): {
  window: Window & typeof globalThis;
  acks: Array<{ origin: string; data: unknown }>;
  parentMessages: Array<{ origin: string; data: ParentMessage }>;
} {
  const html = renderHostHtml(allowedParentOrigins);
  const acks: Array<{ origin: string; data: unknown }> = [];
  const parentMessages: Array<{ origin: string; data: ParentMessage }> = [];
  const loader = options.externalScripts
    ? new StubScriptLoader(options.externalScripts)
    : null;
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    // A concrete document URL so absolute `src` fetches resolve; only set when
    // a test actually stubs external scripts, to leave the rest untouched.
    ...(loader
      ? {
          resources: loader as unknown as ConstructorOptions["resources"],
          url: SANDBOX_ORIGIN + "/render.html",
          // A stubbed load FAILURE is an expected input here; keep jsdom from
          // printing its resource-error dump over the test output.
          virtualConsole: new VirtualConsole().on("jsdomError", () => {}),
        }
      : {}),
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

/* ------------------------------------------------------------------ #1785 */

/** Read the log the stub artifacts append to. */
function artifactLog(window: Window & typeof globalThis): string[] {
  const log = (window as unknown as { __artifactLog?: string[] }).__artifactLog;
  assert.ok(Array.isArray(log), "the artifact log was never seeded");
  return log;
}

/**
 * Wait for the HOST page's own DOMContentLoaded/load to fire before rendering.
 * That is the real sequence — the parent only posts once the iframe has loaded —
 * and it is what makes the synthetic events meaningful: if the test rendered
 * while jsdom was still parsing, jsdom's own later events would be
 * indistinguishable from the host's synthetic ones.
 */
function whenHostLoaded(window: Window & typeof globalThis): Promise<void> {
  if (window.document.readyState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    window.addEventListener("load", () => resolve(), { once: true });
  });
}

/** Seed the log BEFORE rendering so the first artifact script can append to it. */
function seedArtifactLog(window: Window & typeof globalThis): void {
  (window as unknown as { __artifactLog: string[] }).__artifactLog = [];
}

/**
 * Artifact markup that records DOMContentLoaded/load — the bootstrap habit that
 * silently rendered blank before #1785.
 */
const LIFECYCLE_ARTIFACT_SCRIPT =
  "<script>" +
  'document.addEventListener("DOMContentLoaded", function () {' +
  ' window.__artifactLog.push("DOMContentLoaded"); });' +
  'window.addEventListener("load", function () {' +
  ' window.__artifactLog.push("load"); });' +
  CLOSE_SCRIPT;

/** Poll until the host's asynchronous script chain reaches the expected state. */
async function waitFor(
  predicate: () => boolean,
  describe: string,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Give any (incorrect) extra async work a chance to land before asserting. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/**
 * LIMITS OF THIS HARNESS. jsdom runs an inline script inserted from inside
 * another script's `load` handler on a LATER task, not synchronously as every
 * real browser does. So for an artifact that contains an external script, jsdom
 * cannot show the position of the synthetic DOMContentLoaded/load relative to
 * the artifact's own inline scripts — those tests assert only that the chain
 * waits for, and is not stalled by, the external script. The lifecycle events
 * are pinned here on the all-inline path (faithful in jsdom) and end to end, in
 * a real browser, by tests/e2e/atrium-sandbox-script-order.spec.ts.
 */

/**
 * The headline regression: a cdnjs library followed by inline code that uses it.
 * Before #1785 the inline script ran first and threw
 * `ReferenceError: Chart is not defined`.
 */
async function testExternalThenInlineOrdering(): Promise<void> {
  const { window, acks } = makeHost([APP_ORIGIN], {
    externalScripts: { [CHART_CDN_URL]: { kind: "ok", source: CHART_STUB_SOURCE } },
  });
  await whenHostLoaded(window);
  seedArtifactLog(window);

  const code =
    '<script src="' +
    CHART_CDN_URL +
    '">' +
    CLOSE_SCRIPT +
    "<script>" +
    'window.__artifactLog.push("inline sees Chart: " + typeof Chart);' +
    CLOSE_SCRIPT;

  postToHost(window, APP_ORIGIN, { type: "atrium-render", code }, acks);
  // The ack is synchronous even though the chain is not: the parent re-posts
  // until acked, so a deferred ack would restart the render.
  assert.deepEqual(acks[0]?.data, { type: "atrium-artifact-rendered", ok: true });

  await waitFor(
    () => artifactLog(window).length > 0,
    "the inline script that follows the library"
  );
  await settle();
  assert.deepEqual(artifactLog(window), ["inline sees Chart: function"]);
}

/** The lifecycle events fire exactly once — a double fire would double-render. */
async function testLifecycleEventsFireOnce(): Promise<void> {
  const { window, acks } = makeHost([APP_ORIGIN]);
  await whenHostLoaded(window);
  seedArtifactLog(window);
  postToHost(
    window,
    APP_ORIGIN,
    { type: "atrium-render", code: LIFECYCLE_ARTIFACT_SCRIPT },
    acks
  );
  await waitFor(
    () => artifactLog(window).includes("load"),
    "the synthetic load event"
  );
  await settle();
  assert.deepEqual(artifactLog(window), ["DOMContentLoaded", "load"]);
}

/**
 * A CDN that is blocked by the CSP, 404s, or is simply down fires `error`. The
 * rest of the artifact must still run — one dead script must not blank the page.
 */
async function testFailedExternalScriptDoesNotStall(): Promise<void> {
  const { window, acks } = makeHost([APP_ORIGIN], {
    externalScripts: { [CHART_CDN_URL]: { kind: "error" } },
  });
  await whenHostLoaded(window);
  seedArtifactLog(window);

  const code =
    '<script src="' +
    CHART_CDN_URL +
    '">' +
    CLOSE_SCRIPT +
    "<script>" +
    'window.__artifactLog.push("inline ran, Chart=" + typeof Chart);' +
    CLOSE_SCRIPT;

  postToHost(window, APP_ORIGIN, { type: "atrium-render", code }, acks);
  await waitFor(
    () => artifactLog(window).length > 0,
    "the chain to continue past a failed script"
  );
  await settle();
  assert.deepEqual(artifactLog(window), ["inline ran, Chart=undefined"]);
}

/**
 * A non-executable `type` never runs and fires NO load/error, so the chain must
 * not wait on it (waiting would hold the whole artifact for the timeout).
 */
async function testNonExecutableScriptTypeDoesNotStall(): Promise<void> {
  const { window, acks } = makeHost([APP_ORIGIN]);
  await whenHostLoaded(window);
  seedArtifactLog(window);

  const code =
    '<script type="text/template" src="' +
    CHART_CDN_URL +
    '">' +
    CLOSE_SCRIPT +
    "<script>" +
    'window.__artifactLog.push("after template");' +
    CLOSE_SCRIPT +
    LIFECYCLE_ARTIFACT_SCRIPT;

  postToHost(window, APP_ORIGIN, { type: "atrium-render", code }, acks);
  await waitFor(
    () => artifactLog(window).includes("load"),
    "the chain to skip a non-executable script"
  );
  assert.deepEqual(artifactLog(window), [
    "after template",
    "DOMContentLoaded",
    "load",
  ]);
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

  await check(
    "#1785 runs a cdnjs script before the inline code that uses it",
    testExternalThenInlineOrdering
  );
  await check(
    "#1785 fires DOMContentLoaded then load exactly once after the scripts",
    testLifecycleEventsFireOnce
  );
  await check(
    "#1785 a failed external script does not stall the rest of the artifact",
    testFailedExternalScriptDoesNotStall
  );
  await check(
    "#1785 a non-executable script type does not stall the chain",
    testNonExecutableScriptTypeDoesNotStall
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
