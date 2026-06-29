/**
 * Atrium ArtifactSandbox component fail-closed smoke test (Bun + jsdom) — #1052, Phase 2
 *
 * The ArtifactSandbox component has a critical security branch: when its `src`
 * prop is null (sandbox unconfigured or, server-side, resolved to the app origin),
 * the component MUST render the "unavailable" notice rather than falling back to
 * any same-origin rendering of the untrusted code.
 *
 * As of #1052 the render URL is resolved SERVER-SIDE (from `ATRIUM_SANDBOX_ORIGIN`)
 * and passed in as the `src` prop — the component no longer reads env in the
 * browser. So these checks drive the branches directly via the prop:
 *  1. No `src` (or null) → fail closed: unavailable notice present, no <iframe>,
 *     and the untrusted code string never appears in the app-origin DOM.
 *  2. A valid `src` → the cross-origin iframe IS rendered (sandbox="allow-scripts")
 *     and the unavailable notice is gone.
 *
 * The host-page CSP/origin behavior is covered by atrium-artifact-sandbox-host.smoke.ts
 * and the E2E guard spec (atrium-artifact.guard.spec.ts).
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
// The component takes the render URL as the `src` prop (resolved server-side),
// so each branch is driven purely by props — no env manipulation or module
// mocking required.
// ---------------------------------------------------------------------------

// Now import React and the component (after globals are set up).
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

await check(
  "renders the cross-origin sandbox iframe (allow-scripts) when a valid src is provided",
  async () => {
    const container3 = dom.window.document.createElement("div");
    dom.window.document.body.appendChild(container3);
    const root3 = ReactDOM.createRoot(container3 as unknown as Element);

    const { act } = await import("react");
    await act(async () => {
      root3.render(
        React.createElement(ArtifactSandbox, {
          code: "<h1>hi</h1>",
          src: "https://sandbox.example.com/render",
        })
      );
    });

    // The iframe must be present and point at the provided src.
    const iframe = container3.querySelector('[data-testid="artifact-sandbox-frame"]');
    assert.ok(iframe !== null, "iframe was not rendered for a configured src");
    assert.equal(
      iframe.getAttribute("src"),
      "https://sandbox.example.com/render",
      "iframe src does not match the provided prop"
    );
    // SECURITY: allow-scripts ONLY, never allow-same-origin.
    assert.equal(iframe.getAttribute("sandbox"), "allow-scripts", "iframe sandbox attribute is not exactly allow-scripts");

    // The unavailable notice must NOT be present in the configured case.
    const notice = container3.querySelector('[data-testid="artifact-sandbox-unavailable"]');
    assert.ok(notice === null, "unavailable notice rendered despite a configured src");

    root3.unmount();
    container3.remove();
  }
);

console.log(`\nartifact-sandbox-component smoke: ${passed} checks passed`);
