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
import {
  buildAtriumSandboxCsp,
  renderAtriumSandboxHostPage,
} from "@/infra/lib/atrium-sandbox-host-page";

/**
 * jsdom still EXPORTS `ResourceLoader`, and still accepts an instance of it as
 * the `resources` option (it checks `instanceof ResourceLoader`), but
 * @types/jsdom 28 no longer declares either: the typings only describe the
 * undici-dispatcher `ResourcesOptions`, which jsdom added ALONGSIDE the loader
 * rather than in place of it. Subclassing the loader is still the smallest way
 * to serve a stubbed script body with no network, so it is reached through a
 * narrow local type rather than pulling undici mocking into a smoke.
 *
 * The real contract also expects the promise `fetch` returns to carry an
 * `abort()` (jsdom calls it when it tears a request down); this interface does
 * not model that, so StubScriptLoader attaches one by hand.
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
  /** #1787: the frame's forwarded uncaught error / unhandled rejection. */
  message?: unknown;
  /** #1787: set when the forwarded error is a frame-side bridge failure. */
  kind?: unknown;
  code?: unknown;
  sql?: unknown;
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
  // The same builder atrium-sandbox-stack.ts deploys with.
  const csp = buildAtriumSandboxCsp({ parentOrigins: allowedParentOrigins });
  return renderAtriumSandboxHostPage(template, allowedParentOrigins, csp);
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
    /** Records every setTimeout delay the page requests (#1788). */
    timeoutDelays?: number[];
    /** Replaces the page's Date.now before the host script captures it. */
    fakeNow?: () => number;
    /** Receives the page's console.error calls instead of the test output. */
    consoleErrors?: unknown[][];
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
      if (options.timeoutDelayMs !== undefined || options.timeoutDelays) {
        const nativeSetTimeout = hostWindow.setTimeout.bind(hostWindow);
        const recorded = options.timeoutDelays;
        Object.defineProperty(hostWindow, "setTimeout", {
          configurable: true,
          value: (handler: TimerHandler, delay?: number) => {
            if (recorded) recorded.push(delay ?? 0);
            return nativeSetTimeout(
              handler,
              options.timeoutDelayMs ?? delay
            );
          },
        });
      }
      if (options.fakeNow) {
        Object.defineProperty(hostWindow.Date, "now", {
          configurable: true,
          value: options.fakeNow,
        });
      }
      if (options.consoleErrors) {
        const sink = options.consoleErrors;
        hostWindow.console.error = (...args: unknown[]) => {
          sink.push(args);
        };
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

/**
 * #1788 — the dispatch ack restarts the query clock.
 *
 * The parent now QUEUES requests beyond its concurrency limit instead of
 * rejecting the excess, so "the page posted" and "the server was asked" are no
 * longer the same moment. The 45s budget used to start at the post, which is how
 * the later queries of a wide dashboard timed out having never run. The parent
 * posts an ack when it actually dispatches, and the host re-arms the SAME budget
 * from there — at most once, so a repeated ack cannot hold a request open.
 */
async function testDispatchAckRestartsQueryClock(): Promise<void> {
  const timeoutDelays: number[] = [];
  const { window, parentMessages } = makeHost([APP_ORIGIN], { timeoutDelays });
  const api = atriumData(window);

  const queryPromise = api.query("SELECT 1");
  const requestId = parentMessages[0]?.data.requestId;
  // Before the ack the request may still be sitting in the PARENT's queue, so
  // the pre-ack budget has to outlast the worst-case queue wait (32 queued
  // behind 6 concurrent). Arming 45s here would time the tail of a wide
  // dashboard out un-dispatched -- and the parent would then dispatch it
  // anyway, burning a rate-limit slot on an answer nobody is waiting for.
  assert.deepEqual(
    timeoutDelays,
    [315000],
    "query did not arm the queue-tolerant pre-ack budget"
  );

  postDataResponse(window, {
    type: "atrium-artifact-data-ack",
    requestId,
  });
  // Dispatched: now the real 45s SERVER budget, which must outlast the server's
  // own 30s deadline and nothing more.
  assert.deepEqual(
    timeoutDelays,
    [315000, 45000],
    "the dispatch ack did not restart the clock at the server budget"
  );

  // A second ack (a retry, a duplicate post) must NOT extend the budget again.
  postDataResponse(window, {
    type: "atrium-artifact-data-ack",
    requestId,
  });
  assert.deepEqual(timeoutDelays, [315000, 45000], "a repeated ack re-armed the clock");

  // An ack for something not pending is ignored outright.
  postDataResponse(window, {
    type: "atrium-artifact-data-ack",
    requestId: "00000000-0000-4000-8000-00000000dead",
  });
  assert.deepEqual(timeoutDelays, [315000, 45000]);

  // The ack is not an answer: the request is still pending and still resolvable.
  const rows = { columns: ["n"], rows: [[1]] };
  postDataResponse(window, {
    type: "atrium-artifact-data-response",
    requestId,
    ok: true,
    data: rows,
  });
  assert.deepEqual(await queryPromise, rows);
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
    (err: Error & { code?: string }) => {
      assert.match(err.message, /Atrium data request timed out/);
      // #1787: a timeout is its own code, not the catch-all.
      assert.equal(err.code, "timeout");
      return true;
    }
  );
}

/**
 * #1787 (Codex P2 on #1808) — a failure the FRAME raises itself is reported to
 * the parent. The artifact catches the rejection (as the guidance says), so no
 * `unhandledrejection` fires, and the parent never answered; without this
 * report the chat got no diagnostic for a timed-out query at all.
 */
async function testLocalTimeoutIsReportedToParent(): Promise<void> {
  const { window, parentMessages } = makeHost([APP_ORIGIN], { timeoutDelayMs: 0 });
  await assert.rejects(atriumData(window).query("select slow()"));

  const reports = parentMessages.filter(
    (entry) => entry.data.type === "atrium-artifact-error"
  );
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.data.kind, "data");
  assert.equal(reports[0]?.data.code, "timeout");
  assert.equal(reports[0]?.data.sql, "select slow()");
  assert.equal(reports[0]?.origin, "*");
}

/**
 * #1787 — the typed code the parent attaches reaches artifact code as
 * `err.code`, so a page can render "your SQL is wrong" instead of guessing
 * "no access" from a single generic string.
 */
async function testTypedBridgeErrorCodes(): Promise<void> {
  const { window, parentMessages } = makeHost([APP_ORIGIN]);
  const queryPromise = atriumData(window).query("select nope");
  postDataResponse(window, {
    type: "atrium-artifact-data-response",
    requestId: parentMessages[0]?.data.requestId,
    ok: false,
    code: "query_error",
    error: 'column "nope" does not exist',
  });
  await assert.rejects(
    queryPromise,
    (err: Error & { code?: string; retryAfterSeconds?: number }) => {
      assert.equal(err.code, "query_error");
      assert.equal(err.message, 'column "nope" does not exist');
      assert.equal(err.retryAfterSeconds, undefined);
      return true;
    }
  );
}

/** #1787 — `rate_limited` also carries the backoff the viewer should honour. */
async function testRateLimitedCarriesRetryAfter(): Promise<void> {
  const { window, parentMessages } = makeHost([APP_ORIGIN]);
  const queryPromise = atriumData(window).query("select 1");
  postDataResponse(window, {
    type: "atrium-artifact-data-response",
    requestId: parentMessages[0]?.data.requestId,
    ok: false,
    code: "rate_limited",
    error: "Too many data requests. Try again in a moment.",
    retryAfterSeconds: 30,
  });
  await assert.rejects(
    queryPromise,
    (err: Error & { code?: string; retryAfterSeconds?: number }) => {
      assert.equal(err.code, "rate_limited");
      assert.equal(err.retryAfterSeconds, 30);
      return true;
    }
  );
}

/**
 * #1787 — an unknown code must not reach artifact code verbatim: a page that
 * branches on `err.code` would fall through every arm it knows about, so the
 * host normalizes to the catch-all instead.
 */
async function testUnknownBridgeErrorCodeNormalizes(): Promise<void> {
  const { window, parentMessages } = makeHost([APP_ORIGIN]);
  const listPromise = atriumData(window).list("leaderboard");
  postDataResponse(window, {
    type: "atrium-artifact-data-response",
    requestId: parentMessages[0]?.data.requestId,
    ok: false,
    code: "something_new",
    error: "Artifact data request failed",
    retryAfterSeconds: 30,
  });
  await assert.rejects(
    listPromise,
    (err: Error & { code?: string; retryAfterSeconds?: number }) => {
      assert.equal(err.code, "unavailable");
      // The backoff hint only rides on `rate_limited`.
      assert.equal(err.retryAfterSeconds, undefined);
      return true;
    }
  );
}

/**
 * #1787 — the frame forwards its own uncaught errors and unhandled rejections
 * to the parent, which is the only way a `ReferenceError` in an artifact's
 * bootstrap reaches anyone at all (least of all the model that wrote it).
 */
async function testFrameErrorsAreForwardedToParent(): Promise<void> {
  const { window, parentMessages } = makeHost([APP_ORIGIN]);

  window.dispatchEvent(
    new window.ErrorEvent("error", { message: "Chart is not defined" })
  );

  const forwarded = parentMessages.filter(
    (entry) => entry.data.type === "atrium-artifact-error"
  );
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0]?.data.message, "Chart is not defined");
  // Parent-bound only — never a concrete third-party origin.
  assert.equal(forwarded[0]?.origin, "*");
}

async function testMissingRandomUuidDoesNotBreakRendering(): Promise<void> {
  const { window, acks, parentMessages } = makeHost([APP_ORIGIN], {
    disableRandomUuid: true,
  });

  await assert.rejects(
    atriumData(window).list("leaderboard"),
    /Atrium data bridge is unavailable/
  );
  // No data request reaches the parent — only the #1787 diagnostic reporting
  // the frame-side failure.
  assert.deepEqual(
    parentMessages.map((entry) => [entry.data.type, entry.data.code]),
    [["atrium-artifact-error", "unavailable"]]
  );

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
  // No data request reaches the parent — only the #1787 diagnostic reporting
  // the frame-side failure.
  assert.deepEqual(
    parentMessages.map((entry) => [entry.data.type, entry.data.code]),
    [["atrium-artifact-error", "unavailable"]]
  );

  const retry = api.list("leaderboard");
  const requestId = parentMessages.find(
    (entry) => entry.data.type === "atrium-artifact-data-request"
  )?.data.requestId;
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

  // #1787: the refused 33rd call is reported to the parent as a diagnostic.
  assert.deepEqual(
    parentMessages
      .filter((entry) => entry.data.type === "atrium-artifact-error")
      .map((entry) => entry.data.code),
    ["too_many_requests"]
  );

  const afterCleanup = api.list("leaderboard");
  const afterCleanupRequest = parentMessages.filter(
    (entry) => entry.data.type === "atrium-artifact-data-request"
  )[32]?.data;
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

/**
 * Give any (incorrect) extra async work a chance to land before asserting. Kept
 * well above a scheduler tick so a loaded CI runner cannot hide a late
 * duplicate lifecycle event — the regression these checks exist to catch.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
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

/**
 * Never stubbed, so StubScriptLoader returns null and jsdom neither loads it nor
 * fires load/error — a script the host must not wait on. (A never-settling stub
 * would not do: jsdom queues later inline scripts behind a pending fetch, so it
 * would block the page whatever the host decided.)
 */
const SILENT_CDN_URL = "https://cdnjs.cloudflare.com/ajax/libs/never/1.0/never.js";

/**
 * A classic `nomodule` script is skipped by every module-capable browser: never
 * fetched, never run, no load/error. The chain must not wait on it, or every
 * artifact using the module/nomodule pattern would stall for the full timeout.
 * (SILENT_CDN_URL fires nothing, so a chain that waited would stall.)
 */
async function testNomoduleScriptDoesNotStall(): Promise<void> {
  const { window, acks } = makeHost([APP_ORIGIN], {
    externalScripts: {},
  });
  await whenHostLoaded(window);
  seedArtifactLog(window);

  const code =
    '<script nomodule src="' +
    SILENT_CDN_URL +
    '">' +
    CLOSE_SCRIPT +
    "<script>" +
    'window.__artifactLog.push("after nomodule");' +
    CLOSE_SCRIPT;

  postToHost(window, APP_ORIGIN, { type: "atrium-render", code }, acks);
  await waitFor(
    () => artifactLog(window).length > 0,
    "the chain to skip a nomodule script"
  );
  assert.deepEqual(artifactLog(window), ["after nomodule"]);
}

/**
 * An earlier script can remove an ANCESTOR of a later one. The later script
 * still has a parent (the detached wrapper), but it is out of the document, so
 * a recreated copy never runs and never fires load/error. The chain must skip
 * it rather than wait.
 */
async function testDetachedAncestorDoesNotStall(): Promise<void> {
  const { window, acks } = makeHost([APP_ORIGIN], {
    externalScripts: {},
  });
  await whenHostLoaded(window);
  seedArtifactLog(window);

  const code =
    '<script>document.getElementById("wrapper").remove();' +
    CLOSE_SCRIPT +
    '<div id="wrapper"><script src="' +
    SILENT_CDN_URL +
    '">' +
    CLOSE_SCRIPT +
    "</div>" +
    "<script>" +
    'window.__artifactLog.push("after detached");' +
    CLOSE_SCRIPT;

  postToHost(window, APP_ORIGIN, { type: "atrium-render", code }, acks);
  await waitFor(
    () => artifactLog(window).length > 0,
    "the chain to skip a script whose ancestor was removed"
  );
  assert.deepEqual(artifactLog(window), ["after detached"]);
}

/**
 * The chain's total waiting is bounded: once past the deadline, remaining
 * external scripts are inserted without being waited on. The page clock jumps
 * past the deadline after the chain starts; both scripts are silent, so without the
 * bound the inline script would wait behind them for minutes.
 */
async function testChainDeadlineBoundsTotalWait(): Promise<void> {
  let nowCalls = 0;
  const { window, acks } = makeHost([APP_ORIGIN], {
    externalScripts: {},
    // First read sets the deadline; every later read is well past it.
    fakeNow: () => (nowCalls++ === 0 ? 0 : 10 * 60 * 1000),
  });
  await whenHostLoaded(window);
  seedArtifactLog(window);

  const silent = '<script src="' + SILENT_CDN_URL + '">' + CLOSE_SCRIPT;
  const code =
    silent +
    silent +
    "<script>" +
    'window.__artifactLog.push("after deadline");' +
    CLOSE_SCRIPT +
    LIFECYCLE_ARTIFACT_SCRIPT;

  postToHost(window, APP_ORIGIN, { type: "atrium-render", code }, acks);
  await waitFor(
    () => artifactLog(window).includes("load"),
    "the chain to stop waiting once past its deadline"
  );
  assert.deepEqual(artifactLog(window), [
    "after deadline",
    "DOMContentLoaded",
    "load",
  ]);
}

/**
 * When the chain resumes after an external script, artifact code has already
 * run. Replacing document.createElement / Node.prototype.replaceChild must not
 * break it (the host captured both first), and anything else that makes the
 * resumed chain throw must be caught and logged — the render was acked long
 * ago, so an escaped exception would leave a silently half-run artifact.
 *
 * The external script itself breaks Element#setAttribute (which the host does
 * not capture): it runs before its own `load` fires, so the resumed chain
 * reaches it already broken. (Tampering from an inline script inserted on
 * resume would not work here — jsdom runs those on a later task.)
 */
async function testResumedChainSurvivesTamperedGlobals(): Promise<void> {
  const consoleErrors: unknown[][] = [];
  const { window, acks } = makeHost([APP_ORIGIN], {
    externalScripts: {
      [CHART_CDN_URL]: {
        kind: "ok",
        source:
          CHART_STUB_SOURCE +
          'window.__artifactLog.push("external ran");' +
          'Element.prototype.setAttribute = function () { throw new Error("tampered setAttribute"); };',
      },
    },
    consoleErrors,
  });
  await whenHostLoaded(window);
  const uncaught: unknown[] = [];
  window.addEventListener("error", (event) => {
    uncaught.push(event.error ?? event.message);
  });
  seedArtifactLog(window);

  const code =
    "<script>" +
    'document.createElement = function () { throw new Error("tampered createElement"); };' +
    'Node.prototype.replaceChild = function () { throw new Error("tampered replaceChild"); };' +
    CLOSE_SCRIPT +
    '<script src="' +
    CHART_CDN_URL +
    '">' +
    CLOSE_SCRIPT +
    // No attributes, so recreating it needs only the captured createElement +
    // replaceChild — it must survive the first script's tampering.
    "<script>" +
    'window.__artifactLog.push("resumed, Chart=" + typeof Chart);' +
    CLOSE_SCRIPT +
    // Has an attribute, so recreating it calls the broken setAttribute.
    '<script id="never-recreated">' +
    'window.__artifactLog.push("must not run");' +
    CLOSE_SCRIPT;

  postToHost(window, APP_ORIGIN, { type: "atrium-render", code }, acks);
  assert.deepEqual(acks[0]?.data, { type: "atrium-artifact-rendered", ok: true });

  await waitFor(
    () => consoleErrors.length > 0,
    "the host to log the stopped chain"
  );
  await settle();
  assert.deepEqual(artifactLog(window), [
    "external ran",
    "resumed, Chart=function",
  ]);
  assert.match(String(consoleErrors[0]?.[0]), /script chain stopped/);
  // The stop came from setAttribute, not createElement/replaceChild: the
  // captured primitives held.
  assert.match(String(consoleErrors[0]?.[1]), /tampered setAttribute/);
  assert.deepEqual(uncaught, [], "the resumed chain's error escaped uncaught");
}

/**
 * Supersession must not leave a stale bootstrap armed (#1795 review, P2).
 *
 * The parent re-posts the artifact until its ack lands, so a second render
 * routinely arrives while the first chain is still parked on a CDN. Bumping the
 * render generation abandons that chain, but it cannot unregister the
 * DOMContentLoaded/load handlers the chain's EARLIER inline scripts already
 * installed on window/document. Without the tracking purge, the replacement
 * chain's synthetic dispatch runs those stale handlers too, initializing the
 * artifact twice and repeating side effects such as AtriumData.submit.
 *
 * The listener therefore has to be registered BEFORE the script that parks the
 * chain — a listener that sits after it is never reached, which is why the
 * ordering test does not catch this.
 */
async function testSupersededChainLeavesNoStaleLifecycleListener(): Promise<void> {
  // A loader with no stubs: SILENT_CDN_URL is never loaded and fires nothing.
  const { window, acks } = makeHost([APP_ORIGIN], { externalScripts: {} });
  // The parked script leaves the chain's 60s fallback timer armed, so the
  // window is torn down at the end: otherwise it holds the process open for a
  // full minute after the assertions are done.
  try {
    await whenHostLoaded(window);
    seedArtifactLog(window);

    const superseded =
      "<script>" +
      'document.addEventListener("DOMContentLoaded", function () {' +
      ' window.__artifactLog.push("STALE DOMContentLoaded"); });' +
      'window.addEventListener("load", function () {' +
      ' window.__artifactLog.push("STALE load"); });' +
      'window.onload = function () { window.__artifactLog.push("STALE onload"); };' +
      'window.__artifactLog.push("stale listeners registered");' +
      CLOSE_SCRIPT +
      // Parks the chain here: the script never loads or fires, and the
      // per-script fallback is 60s, so this render is still mid-chain when the
      // next lands. (A never-settling stub cannot model this in jsdom — see
      // SILENT_CDN_URL.)
      '<script src="' +
      SILENT_CDN_URL +
      '">' +
      CLOSE_SCRIPT;

    postToHost(
      window,
      APP_ORIGIN,
      { type: "atrium-render", code: superseded },
      acks
    );
    await waitFor(
      () => artifactLog(window).includes("stale listeners registered"),
      "the superseded render's inline script to register its listeners"
    );

    // The parent re-posts because the first ack was slow; this is the live chain.
    postToHost(
      window,
      APP_ORIGIN,
      { type: "atrium-render", code: LIFECYCLE_ARTIFACT_SCRIPT },
      acks
    );
    await waitFor(
      () => artifactLog(window).includes("load"),
      "the replacement chain's synthetic load event"
    );
    await settle();

    assert.deepEqual(
      artifactLog(window),
      ["stale listeners registered", "DOMContentLoaded", "load"],
      "the superseded render's lifecycle handlers fired again"
    );
  } finally {
    window.close();
  }
}

/**
 * The parent re-posts the SAME code until it sees an ack, so a duplicate lands
 * while the first render is still waiting on its CDN script. Re-rendering for
 * it would leave that in-flight script to execute into the replacement render
 * (#1795 review). A duplicate must be acked without re-rendering: the library
 * and the inline code each run exactly once. (The lifecycle pair after an
 * external script is not observable in jsdom — see LIMITS OF THIS HARNESS — so
 * the Chromium spec pins that part.)
 */
async function testDuplicateRenderIsAckedNotRerun(): Promise<void> {
  const { window, acks } = makeHost([APP_ORIGIN], {
    externalScripts: {
      [CHART_CDN_URL]: {
        kind: "ok",
        source: CHART_STUB_SOURCE + 'window.__artifactLog.push("library ran");',
      },
    },
  });
  await whenHostLoaded(window);
  seedArtifactLog(window);

  const code =
    '<script src="' +
    CHART_CDN_URL +
    '">' +
    CLOSE_SCRIPT +
    "<script>" +
    'window.__artifactLog.push("inline ran");' +
    CLOSE_SCRIPT;

  postToHost(window, APP_ORIGIN, { type: "atrium-render", code }, acks);
  postToHost(window, APP_ORIGIN, { type: "atrium-render", code }, acks);
  const ok = { type: "atrium-artifact-rendered", ok: true };
  assert.deepEqual(
    acks.map((ack) => ack.data),
    [ok, ok],
    "every post must still be acked"
  );

  await waitFor(
    () => artifactLog(window).includes("inline ran"),
    "the single render's inline script"
  );
  await settle();
  assert.deepEqual(artifactLog(window), ["library ran", "inline ran"]);
}

/** The AtriumData bridge checks, split out to keep `main` readable. */
async function runBridgeChecks(): Promise<void> {
  await check(
    "installs AtriumData before artifact scripts execute",
    testAtriumDataReadyBeforeArtifact
  );
  await check(
    "submit and list use UUID-correlated bridge envelopes",
    testBridgeEnvelopes
  );
  await check(
    "restarts the query clock on the parent's dispatch ack, once",
    testDispatchAckRestartsQueryClock
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
  await check(
    "reports a frame-side query timeout to the parent as a data diagnostic",
    testLocalTimeoutIsReportedToParent
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

  await runBridgeChecks();

  await check(
    "#1787 a rejected query carries the typed err.code and its message",
    testTypedBridgeErrorCodes
  );
  await check(
    "#1787 rate_limited carries err.retryAfterSeconds",
    testRateLimitedCarriesRetryAfter
  );
  await check(
    "#1787 an unknown code normalizes to unavailable",
    testUnknownBridgeErrorCodeNormalizes
  );
  await check(
    "#1787 the frame forwards its uncaught errors to the parent",
    testFrameErrorsAreForwardedToParent
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
  await check(
    "#1785 a classic nomodule script does not stall the chain",
    testNomoduleScriptDoesNotStall
  );
  await check(
    "#1785 a script whose ancestor was removed does not stall the chain",
    testDetachedAncestorDoesNotStall
  );
  await check(
    "#1785 the chain stops waiting once past its overall deadline",
    testChainDeadlineBoundsTotalWait
  );
  await check(
    "#1785 the resumed chain survives tampered globals and never throws uncaught",
    testResumedChainSurvivesTamperedGlobals
  );
  await check(
    "#1785 a superseded chain's lifecycle listeners do not fire on the replacement render",
    testSupersededChainLeavesNoStaleLifecycleListener
  );
  await check(
    "#1785 a duplicate post of the same code is acked without re-rendering",
    testDuplicateRenderIsAckedNotRerun
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
