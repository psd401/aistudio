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
