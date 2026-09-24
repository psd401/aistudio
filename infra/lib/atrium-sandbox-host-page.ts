/**
 * Atrium sandbox host page assembly (#1052, #1785) — the ONE place the sandbox
 * CSP string and the render.html token substitution are built.
 *
 * AtriumSandboxStack uses it for the deployed page and the CloudFront CSP
 * header; the jsdom smoke (tests/smoke/atrium-artifact-sandbox-host) and the
 * Chromium spec (tests/e2e/atrium-sandbox-script-order) use it to load the page
 * exactly as deployed, so a change to the CSP shape reaches every copy at once.
 *
 * Deliberately free of aws-cdk-lib and of file IO: the root test runners import
 * it directly, and each caller already knows where render.html lives relative
 * to itself. Inputs must already be normalized origins — the stack runs them
 * through its synth-time validator first.
 */

export interface AtriumSandboxCspInput {
  /** App origins allowed to embed the sandbox (frame-ancestors). */
  parentOrigins: readonly string[];
  /** CDN origins allowed for script-src / style-src / img-src. */
  cdns?: readonly string[];
  /** Origins allowed for media-src (agent-generated MP3/MP4). */
  mediaOrigins?: readonly string[];
}

/**
 * STRICT CSP for the sandbox host. connect-src 'none' blocks first-party API
 * calls / exfiltration; script-src/style-src widen ONLY for allowlisted CDNs.
 * img-src is intentionally restricted to data: only (no https: wildcard) to
 * prevent artifact code from using pixel-tracker images for data exfiltration
 * to arbitrary HTTPS hosts. Artifacts that need to display images must embed
 * them inline (data URLs) or load from an explicitly allowlisted CDN.
 * media-src likewise stays data: + explicitly allowlisted media origins (the
 * workspace media bucket for agent-generated MP3/MP4) — never a wildcard, and
 * connect-src stays 'none', so a single trusted media origin is not a general
 * exfiltration channel.
 * frame-ancestors restricts who can embed the host to the allowed parent origins.
 */
export function buildAtriumSandboxCsp(input: AtriumSandboxCspInput): string {
  const cdns = input.cdns ?? [];
  const mediaOrigins = input.mediaOrigins ?? [];
  const scriptSrc = ["'unsafe-inline'", ...cdns].join(' ');
  // style-src mirrors script-src: an allowlisted CDN (e.g. a Bootstrap/Tailwind
  // stylesheet on cdnjs) must be loadable for an artifact that opts into it,
  // matching the documented behavior that the CDN allowlist governs BOTH
  // script-src and style-src. Without this, an operator who allowlists a CDN
  // sees stylesheets silently blocked and may "fix" it by widening to https:/*,
  // which would defeat the tight img-src/exfiltration controls.
  const styleSrc = ["'unsafe-inline'", ...cdns].join(' ');
  const imgSrc = cdns.length > 0
    ? `data: ${cdns.join(' ')}`  // allowlisted CDN images + data URLs
    : 'data:';                   // data URIs only when no CDNs configured
  // media-src: always allow data: (inline VTT captions + dry-run placeholder
  // clips) plus any configured workspace media origin(s) for real MP3/MP4 URLs.
  const mediaSrc = mediaOrigins.length > 0
    ? `data: ${mediaOrigins.join(' ')}`
    : 'data:';
  const frameAncestors =
    input.parentOrigins.length > 0
      ? input.parentOrigins.join(' ')
      : "'none'";
  return [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    `style-src ${styleSrc}`,
    `img-src ${imgSrc}`,
    `media-src ${mediaSrc}`,
    'font-src data:',
    "connect-src 'none'",
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'none'",
    "form-action 'none'",
    "worker-src 'none'",
    // WebRTC is the one network channel CSP's fetch directives do NOT govern:
    // an RTCPeerConnection can carry data out of the frame even under
    // `connect-src 'none'`. Low bandwidth, but the whole no-egress invariant
    // that lets viewer-scoped data queries ship without per-artifact review
    // (#1705) depends on there being no channel at all, so block it
    // explicitly. Browsers without `webrtc` support ignore the directive.
    "webrtc 'block'",
  ].join('; ');
}

/**
 * Substitute the deploy-time tokens into the render.html template: the parent
 * origin allowlist (JSON) and the CSP meta fallback. replaceAll (not replace):
 * guard against a future edit reintroducing a token elsewhere in the template —
 * replace() would substitute only the first.
 */
export function renderAtriumSandboxHostPage(
  template: string,
  parentOrigins: readonly string[],
  cspPolicy: string
): string {
  return template
    .replaceAll('__ALLOWED_PARENT_ORIGINS__', JSON.stringify(parentOrigins))
    .replaceAll('__CSP_POLICY__', cspPolicy);
}
