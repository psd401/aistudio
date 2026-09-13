/**
 * Atrium artifact sandbox configuration (#1052, Epic #1059, Phase 2)
 *
 * Central resolution of the cross-origin artifact sandbox settings (spec §19.2,
 * §28.1, §30.1). Two pieces of configuration:
 *
 * - `ATRIUM_SANDBOX_ORIGIN` — the SEPARATE origin (distinct subdomain /
 *   CloudFront distribution) that serves the locked-down artifact host page.
 *   Untrusted artifact code runs only there, never on the app origin. It is a
 *   PUBLIC URL (not a secret), so it is also exposed to the browser via
 *   `NEXT_PUBLIC_ATRIUM_SANDBOX_ORIGIN` for the client `<ArtifactSandbox>`.
 * - `ATRIUM_ALLOWED_ARTIFACT_CDNS` — a comma-separated allowlist of CDN origins
 *   the sandbox host's CSP permits (`script-src`/`style-src`). Used to build the
 *   static host page's CSP in the CDK stack; surfaced here so a single parser is
 *   shared by tests and infra-adjacent code.
 *
 * SECURITY: the origin is used both to (a) set the iframe `src` and (b) as the
 * `targetOrigin` of the `postMessage` carrying the code, so a mis-set value can
 * never deliver code to the app origin. We therefore REJECT an origin that
 * resolves to the app's own origin (`NEXT_PUBLIC_APP_URL`) — a same-origin
 * sandbox would defeat the entire isolation model (the iframe could then reach
 * app cookies/localStorage). When unset or invalid the sandbox is treated as
 * unconfigured and the UI shows a "sandbox unavailable" state rather than
 * silently rendering untrusted code on the app origin.
 */

/** A canonical origin string (scheme + host + optional port), no trailing slash. */
export type SandboxOrigin = string;

/**
 * Normalize a raw origin value to a canonical `scheme://host[:port]` with no path
 * or trailing slash, or return `null` when it is missing/blank/not a valid
 * absolute http(s) URL. Centralizing this keeps the iframe `src`, the
 * `postMessage` targetOrigin, and the CSP `frame-src` entry byte-identical (a
 * mismatch would silently break delivery or the frame load).
 */
export function normalizeOrigin(raw: string | undefined | null): SandboxOrigin | null {
  if (!raw || typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // Only http(s); the sandbox is served over the network, never file:/data:.
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.origin;
}

/**
 * Resolve the artifact sandbox origin from the environment. Reads the
 * `NEXT_PUBLIC_` var first (the only one inlined into the client bundle), then
 * the server-only `ATRIUM_SANDBOX_ORIGIN` as a fallback for server contexts.
 *
 * Returns `null` (sandbox unconfigured) when:
 * - neither var is set / valid, OR
 * - the configured origin equals the app's own origin (`NEXT_PUBLIC_APP_URL`).
 *   A same-origin "sandbox" is not a sandbox — it would share cookies/storage
 *   with the app. Failing closed here forces a deployment to provision the
 *   separate origin before any artifact can render.
 */
export function getArtifactSandboxOrigin(): SandboxOrigin | null {
  const configured =
    normalizeOrigin(process.env.NEXT_PUBLIC_ATRIUM_SANDBOX_ORIGIN) ??
    normalizeOrigin(process.env.ATRIUM_SANDBOX_ORIGIN);
  if (!configured) return null;

  const appOrigin = normalizeOrigin(process.env.NEXT_PUBLIC_APP_URL);
  if (appOrigin && appOrigin === configured) {
    // Fail closed: a sandbox sharing the app origin defeats the isolation model.
    // When NEXT_PUBLIC_APP_URL is not set we cannot verify the origins differ —
    // but rather than fail all dev/CI environments that omit APP_URL, we only
    // reject the provably-wrong case (same-origin detected). The iframe
    // sandbox="allow-scripts" (never allow-same-origin) provides the opaque-origin
    // backstop even if this guard is bypassed by a misconfiguration.
    return null;
  }
  return configured;
}

/** The host page path the sandbox origin serves (receives code via postMessage). */
export const SANDBOX_RENDER_PATH = "/render";

/** The full sandbox render URL, or `null` when the sandbox is unconfigured. */
export function getArtifactSandboxRenderUrl(): string | null {
  const origin = getArtifactSandboxOrigin();
  return origin ? `${origin}${SANDBOX_RENDER_PATH}` : null;
}

/**
 * Parse the comma-separated CDN allowlist into normalized origins. Invalid or
 * blank entries are dropped. Used by the CDK stack to assemble the sandbox
 * host's CSP `script-src`/`style-src` (and surfaced for tests). The app origin
 * is never auto-added; the sandbox must not be able to load app-origin scripts.
 */
export function parseAllowedArtifactCdns(
  raw: string | undefined | null = process.env.ATRIUM_ALLOWED_ARTIFACT_CDNS
): SandboxOrigin[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: SandboxOrigin[] = [];
  for (const part of raw.split(",")) {
    const origin = normalizeOrigin(part);
    if (origin && !seen.has(origin)) {
      seen.add(origin);
      out.push(origin);
    }
  }
  return out;
}

/**
 * One-sentence authoring rule describing what the sandbox CSP permits, built
 * from the SAME allowlist the CDK stack bakes into `script-src`/`style-src`
 * (#1750).
 *
 * Why this exists: the sandbox CSP is `default-src 'none'` + inline-only, so a
 * `<script src="https://…cdn…/chart.js">` is blocked with no visible error — the
 * page renders and the charts are simply empty. Nothing on any authoring path
 * (Nexus workspace chat, the MCP `create_artifact`/`create_version` tools, the
 * `psd-atrium` skill) used to state the rule, so the default move for a model
 * asked to "build a dashboard" — reach for a chart library on a CDN — failed
 * silently. This string is the single source of truth for that rule; every
 * authoring surface appends it to what the model reads before it writes code.
 *
 * Defaults to the deployment's real allowlist (`ATRIUM_ALLOWED_ARTIFACT_CDNS`,
 * the same value the CSP is rendered from) so the sentence can never name an
 * origin the browser does not actually permit. The explicit `allowedCdns`
 * parameter exists so tests can cover both deployment shapes without mutating
 * the environment.
 */
export function buildArtifactCspGuidance(
  allowedCdns: SandboxOrigin[] = parseAllowedArtifactCdns()
): string {
  const base =
    "SANDBOX CSP: the artifact runs under a strict Content-Security-Policy. Write your own JavaScript and CSS INLINE in the artifact — inline <script> and <style> are allowed and are the intended way to build one — but the artifact can never reach the network from code (connect-src 'none', so fetch/XHR/WebSocket are blocked).";
  if (allowedCdns.length === 0) {
    return (
      `${base} It also permits no external scripts or styles at all — a <script src> or <link href> to any origin is blocked silently (the page renders, the feature is just dead). ` +
      "Draw charts with inline SVG or a <canvas> painted by inline code."
    );
  }
  return (
    `${base} The only external scripts and styles it may load are from these origins: ${allowedCdns.join(", ")} — pin an exact version in the URL (never "latest"), because an allowlisted CDN serves code with the artifact's own privileges. ` +
    "Anything loaded from another origin is blocked silently (the page renders, the feature is just dead), so prefer inline SVG or a <canvas> painted by inline code when a library is not worth the dependency."
  );
}
