/**
 * CDK assertion test for the Atrium sandbox Content-Security-Policy (#1245).
 *
 * The sandbox renders agent-authored artifacts under a STRICT CSP. A
 * psd-learning-page artifact embeds a generated explainer video + narration
 * audio whose URLs live on the workspace media bucket
 * (`https://psd-agents-<env>-<account>.s3.<region>.amazonaws.com/...`). Those
 * `<video>`/`<audio>`/`<track>` loads are governed by `media-src`, which — with
 * the base `default-src 'none'` — must be present and scoped to that origin (plus
 * `data:` for inline captions/placeholders) for the media to play. This test
 * locks in that the media-src is (a) present, (b) scoped to the provided origin,
 * (c) NOT a wildcard, and (d) does not weaken the `connect-src 'none'` exfil gate.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AtriumSandboxStack } from '../lib/atrium-sandbox-stack';

function cspOf(props: {
  allowedMediaOrigins?: string[];
  allowedArtifactCdns?: string[];
}): string {
  const app = new cdk.App();
  const stack = new AtriumSandboxStack(app, 'TestSandbox', {
    environment: 'dev',
    allowedParentOrigins: ['https://dev.example.psd401.ai'],
    allowedArtifactCdns: props.allowedArtifactCdns ?? [],
    allowedMediaOrigins: props.allowedMediaOrigins,
    env: { account: '123456789012', region: 'us-east-1' },
  });
  const json = JSON.stringify(Template.fromStack(stack).toJSON());
  const m = json.match(/default-src 'none'[^"\\]*/);
  if (!m) throw new Error('CSP not found in synthesized sandbox template');
  return m[0];
}

const BUCKET_ORIGIN = 'https://psd-agents-dev-123456789012.s3.us-east-1.amazonaws.com';

describe('AtriumSandboxStack CSP media-src', () => {
  it('scopes media-src to the provided workspace origin + data:', () => {
    const csp = cspOf({ allowedMediaOrigins: [BUCKET_ORIGIN] });
    expect(csp).toContain(`media-src data: ${BUCKET_ORIGIN}`);
  });

  it('never uses a media-src wildcard', () => {
    const csp = cspOf({ allowedMediaOrigins: [BUCKET_ORIGIN] });
    expect(csp).not.toMatch(/media-src[^;]*\*/);
    expect(csp).not.toMatch(/media-src[^;]*https:(?!\/\/)/); // no bare `https:` scheme source
  });

  it('falls back to data: only when no media origins are configured', () => {
    const csp = cspOf({ allowedMediaOrigins: [] });
    expect(csp).toContain('media-src data:');
    expect(csp).not.toContain('s3.us-east-1.amazonaws.com');
  });

  it('keeps the default and network sources closed', () => {
    const csp = cspOf({ allowedMediaOrigins: [BUCKET_ORIGIN] });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
  });

  // #1705 — viewer-scoped data queries rest on a "no egress from the frame"
  // invariant. WebRTC is the one channel CSP's fetch directives do not cover,
  // so it must stay explicitly blocked alongside connect-src.
  it("blocks WebRTC, the channel connect-src does not govern", () => {
    const csp = cspOf({ allowedMediaOrigins: [BUCKET_ORIGIN] });
    expect(csp).toContain("webrtc 'block'");
  });

  // img-src must never gain an https wildcard: a pixel beacon would reopen
  // exfiltration even with connect-src closed.
  it('never allows an https wildcard in img-src', () => {
    const csp = cspOf({ allowedMediaOrigins: [BUCKET_ORIGIN] });
    const imgSrc = csp.split('; ').find((d: string) => d.startsWith('img-src'));
    expect(imgSrc).toBeDefined();
    expect(imgSrc).not.toContain('https:');
    expect(imgSrc).not.toContain('*');
  });

  it('rejects a non-http(s) media origin at synth', () => {
    expect(() => cspOf({ allowedMediaOrigins: ['ftp://evil.example'] })).toThrow();
  });
});

/**
 * #1750 — the CDN allowlist. The allowlist plumbing already existed but the
 * `atriumAllowedArtifactCdns` context key was never set, so `script-src` stayed
 * inline-only and every artifact that loaded Chart.js/D3/Tailwind from a CDN got
 * the script dropped with no visible error. These lock in the directive SHAPE the
 * authoring guidance promises: `'unsafe-inline'` plus exactly the configured
 * origins, on script-src AND style-src, with no widening of the egress gate.
 */
describe('AtriumSandboxStack CSP script-src/style-src (CDN allowlist, #1750)', () => {
  const CDN = 'https://cdnjs.cloudflare.com';
  const directive = (csp: string, name: string): string | undefined =>
    csp.split('; ').find((d: string) => d.startsWith(`${name} `) || d === name);

  it('is inline-only on both script-src and style-src when no CDN is allowlisted', () => {
    const csp = cspOf({ allowedArtifactCdns: [] });
    expect(directive(csp, 'script-src')).toBe("script-src 'unsafe-inline'");
    expect(directive(csp, 'style-src')).toBe("style-src 'unsafe-inline'");
  });

  it("is 'unsafe-inline' plus EXACTLY the configured origins", () => {
    const csp = cspOf({ allowedArtifactCdns: [CDN] });
    expect(directive(csp, 'script-src')).toBe(`script-src 'unsafe-inline' ${CDN}`);
    expect(directive(csp, 'style-src')).toBe(`style-src 'unsafe-inline' ${CDN}`);
  });

  it('extends img-src to the same origins (a CDN stylesheet pulls its sprites)', () => {
    const csp = cspOf({ allowedArtifactCdns: [CDN] });
    expect(directive(csp, 'img-src')).toBe(`img-src data: ${CDN}`);
  });

  it('normalizes an entry with a path or trailing slash to a bare origin', () => {
    // A raw "https://cdnjs.cloudflare.com/ajax/libs/" entry in the CSP would be a
    // path-prefixed source, which is legal CSP but not what the docs promise.
    const csp = cspOf({ allowedArtifactCdns: ['https://cdnjs.cloudflare.com/ajax/libs/'] });
    expect(directive(csp, 'script-src')).toBe(`script-src 'unsafe-inline' ${CDN}`);
  });

  it('rejects a non-http(s) CDN entry at synth rather than widening the CSP with junk', () => {
    expect(() => cspOf({ allowedArtifactCdns: ['ftp://evil.example'] })).toThrow();
    expect(() => cspOf({ allowedArtifactCdns: ['not-a-url'] })).toThrow();
  });

  it('names the OFFENDING prop in the synth failure, not allowedParentOrigins', () => {
    // The normalizer is shared by three lists. It used to blame
    // allowedParentOrigins for every bad entry, sending an operator who typo'd a
    // cdk.json CDN origin to the wrong key.
    expect(() => cspOf({ allowedArtifactCdns: ['not-a-url'] })).toThrow(
      /allowedArtifactCdns/
    );
    expect(() => cspOf({ allowedMediaOrigins: ['ftp://evil.example'] })).toThrow(
      /allowedMediaOrigins/
    );
  });

  it('never lets the CDN allowlist reopen the egress gate', () => {
    // The whole reason a CDN allowlist is acceptable: an allowlisted script still
    // cannot phone home. If this ever regresses, the security review in
    // docs/DEPLOYMENT.md is no longer true.
    const csp = cspOf({ allowedArtifactCdns: [CDN] });
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("webrtc 'block'");
    expect(directive(csp, 'script-src')).not.toContain('*');
    expect(directive(csp, 'script-src')).not.toContain("'unsafe-eval'");
  });
});
