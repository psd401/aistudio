/// <reference types="bun-types" />
/**
 * Atrium ArtifactSandbox component fail-closed smoke test (Bun + jsdom) — #1052, Phase 2
 *
 * The ArtifactSandbox component has a critical security branch: when
 * `getArtifactSandboxRenderUrl()` returns null (unconfigured or same-origin
 * sandbox), the component MUST render the "unavailable" notice rather than
 * falling back to any same-origin rendering of the untrusted code.
 *
 * This smoke tests the fail-closed branch directly by:
 *  1. Stubbing `getArtifactSandboxRenderUrl` to return null (unconfigured).
 *  2. Rendering the component via React + ReactDOM into jsdom.
 *  3. Asserting that the unavailable notice (data-testid="artifact-sandbox-unavailable")
 *     is present and that no <iframe> (data-testid="artifact-sandbox-frame") is rendered.
 *
 * The configured/happy-path branch (iframe present, code posted via postMessage)
 * is covered by the host-page smoke (atrium-artifact-sandbox-host.smoke.ts) and
 * the E2E guard spec (atrium-artifact.guard.spec.ts).
 *
 * Why Bun and not jest: ArtifactSandbox imports React hooks + the config lib
 * which next/jest's SWC transform does not cleanly handle for component-level
 * DOM assertion. Pattern follows atrium-artifact-sandbox-host.smoke.ts.
 *
 * Run: `bun run tests/smoke/atrium-artifact-sandbox-component.smoke.ts`
 */

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// ---------------------------------------------------------------------------
// Minimal jsdom environment for React rendering
// ---------------------------------------------------------------------------

const dom = new JSDOM("<!DOCTYPE html><body><div id='root'></div></body>", {
  url: "https://app.example.com",
});

// Patch globals that React expects in a browser-like environment.
const g = globalThis as typeof globalThis & {
  window: typeof dom.window;
  document: typeof dom.window.document;
  navigator: typeof dom.window.navigator;
  HTMLElement: typeof dom.window.HTMLElement;
  Element: typeof dom.window.Element;
  Node: typeof dom.window.Node;
  Text: typeof dom.window.Text;
  Event: typeof dom.window.Event;
  MessageEvent: typeof dom.window.MessageEvent;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
g.window = dom.window as any;
g.document = dom.window.document;
g.navigator = dom.window.navigator;
g.HTMLElement = dom.window.HTMLElement as unknown as typeof globalThis.HTMLElement;
g.Element = dom.window.Element as unknown as typeof globalThis.Element;
g.Node = dom.window.Node as unknown as typeof globalThis.Node;
g.Text = dom.window.Text as unknown as typeof globalThis.Text;
g.Event = dom.window.Event as unknown as typeof globalThis.Event;
g.MessageEvent = dom.window.MessageEvent as unknown as typeof globalThis.MessageEvent;

// ---------------------------------------------------------------------------
// Stub the config module so the component sees "sandbox not configured".
// We use Bun's module mock to replace getArtifactSandboxRenderUrl with a
// function returning null before the component module loads.
// ---------------------------------------------------------------------------

import { mock } from "bun:test";

mock.module("@/lib/content/artifact-sandbox-config", () => ({
  getArtifactSandboxOrigin: () => null,
  getArtifactSandboxRenderUrl: () => null,
}));

// Now import React and the component (after globals and mock are set up).
const React = await import("react");
const ReactDOM = await import("react-dom/client");
const { ArtifactSandbox } = await import("@/components/atrium/ArtifactSandbox");

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  const r = fn();
  if (r instanceof Promise) await r;
  passed += 1;
  console.log(`  ✓ ${name}`);
}

await check(
  "renders unavailable notice (not an iframe) when sandbox origin is unconfigured",
  async () => {
    const container = dom.window.document.getElementById("root")!;
    const root = ReactDOM.createRoot(container as unknown as Element);

    // Wrap in act so React flushes state initializers before we assert.
    const { act } = await import("react");
    await act(async () => {
      root.render(React.createElement(ArtifactSandbox, { code: "<h1>untrusted</h1>" }));
    });

    // The unavailable notice must be present.
    const notice = container.querySelector('[data-testid="artifact-sandbox-unavailable"]');
    assert.ok(notice !== null, "unavailable notice was not rendered");

    // No iframe must be rendered (untrusted code must not reach the app origin).
    const iframe = container.querySelector('[data-testid="artifact-sandbox-frame"]');
    assert.ok(iframe === null, "iframe was rendered despite unconfigured sandbox — fail-open!");

    // The untrusted code string itself must not appear anywhere in the DOM.
    assert.doesNotMatch(
      container.innerHTML,
      /untrusted/,
      "untrusted code string appeared in the app-origin DOM"
    );

    root.unmount();
  }
);

await check(
  "unavailable notice contains the env var name so operators know what to configure",
  async () => {
    const container2 = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(container2);
    const root2 = ReactDOM.createRoot(container2 as unknown as Element);

    const { act } = await import("react");
    await act(async () => {
      root2.render(React.createElement(ArtifactSandbox, { code: "" }));
    });

    const notice = container2.querySelector('[data-testid="artifact-sandbox-unavailable"]');
    assert.ok(notice !== null, "unavailable notice missing");
    assert.ok(
      notice.textContent?.includes("ATRIUM_SANDBOX_ORIGIN"),
      `Operator-facing env var name missing from notice: ${notice.textContent}`
    );

    root2.unmount();
    container2.remove();
  }
);

console.log(`\nartifact-sandbox-component smoke: ${passed} checks passed`);
