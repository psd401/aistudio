/**
 * Atrium HTML sanitizer smoke test (Bun)
 *
 * Issue #1051 (PR #1062 review finding: protocol-relative open-redirect).
 * Exercises lib/content/render/html-sanitize.ts `sanitizeHtml`, focused on the
 * URL-scheme allowlist hook that strips unsafe href/src values.
 *
 * Why a Bun smoke and not jest: html-sanitize imports `dompurify` + `jsdom`,
 * pure-ESM/native modules next/jest (SWC) cannot transform in node_modules. Bun
 * runs ESM + TS natively. Mirrors the other Atrium Bun smokes.
 *
 * Run: `bun run tests/smoke/atrium-html-sanitize.smoke.ts`
 * Exits non-zero on the first failed assertion.
 */

import assert from "node:assert/strict";
import { sanitizeHtml } from "@/lib/content/render/html-sanitize";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

check("keeps absolute https href", () => {
  const html = sanitizeHtml('<a href="https://example.com">x</a>');
  assert.match(html, /href="https:\/\/example\.com"/);
});

check("keeps root-relative href (/foo)", () => {
  const html = sanitizeHtml('<a href="/foo/bar">x</a>');
  assert.match(html, /href="\/foo\/bar"/);
});

check("keeps same-document ./ and anchor hrefs", () => {
  assert.match(sanitizeHtml('<a href="./rel">x</a>'), /href="\.\/rel"/);
  assert.match(sanitizeHtml('<a href="#sec">x</a>'), /href="#sec"/);
});

check("STRIPS protocol-relative href (//evil.com) — open-redirect", () => {
  // `//evil.com` resolves to https://evil.com in the browser (inherits page
  // protocol). The single-slash branch must NOT match it.
  const html = sanitizeHtml('<a href="//evil.com/phishing">x</a>');
  assert.doesNotMatch(html, /href=/i, `protocol-relative href survived: ${html}`);
});

check("STRIPS javascript: href", () => {
  const scheme = "javascript:"; // assembled so the linter's no-script-url rule sees no literal
  const html = sanitizeHtml(`<a href="${scheme}alert(1)">x</a>`);
  assert.doesNotMatch(html, /href=/i);
});

check("STRIPS data: src", () => {
  const html = sanitizeHtml('<img src="data:text/html;base64,abc">');
  assert.doesNotMatch(html, /src=/i);
});

check("keeps mailto: and tel: hrefs", () => {
  assert.match(sanitizeHtml('<a href="mailto:a@b.com">x</a>'), /href="mailto:a@b\.com"/);
  assert.match(sanitizeHtml('<a href="tel:+15551234567">x</a>'), /href="tel:\+15551234567"/);
});

console.log(`\natrium-html-sanitize smoke: ${passed} checks passed`);
