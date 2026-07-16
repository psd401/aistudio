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

  it('keeps connect-src none (media-src does not open an exfil channel)', () => {
    const csp = cspOf({ allowedMediaOrigins: [BUCKET_ORIGIN] });
    expect(csp).toContain("connect-src 'none'");
  });

  it('rejects a non-http(s) media origin at synth', () => {
    expect(() => cspOf({ allowedMediaOrigins: ['ftp://evil.example'] })).toThrow();
  });
});
