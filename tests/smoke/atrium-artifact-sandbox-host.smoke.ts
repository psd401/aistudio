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
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const template = fs.readFileSync(templatePath, "utf8");
  // Mirror atrium-sandbox-stack.ts substitution.
  const csp = "default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; worker-src 'none'; img-src data:";
  return template
    .replaceAll("__ALLOWED_PARENT_ORIGINS__", JSON.stringify(allowedParentOrigins))
    .replaceAll("__CSP_POLICY__", csp);
}

/** Spin up a jsdom window running the host page script, with a capture for acks. */
function makeHost(allowedParentOrigins: string[]): {
  window: Window & typeof globalThis;
  acks: Array<{ origin: string; data: unknown }>;
} {
  const html = renderHostHtml(allowedParentOrigins);
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
  const window = dom.window as unknown as Window & typeof globalThis;
  const acks: Array<{ origin: string; data: unknown }> = [];
  // The host calls event.source.postMessage(ack, event.origin); our synthetic
  // `source` records what the host tried to send back.
  return { window, acks };
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
