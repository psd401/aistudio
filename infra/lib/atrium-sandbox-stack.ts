import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Atrium artifact sandbox origin (#1052, Epic #1059, Phase 2, spec §19.2 / §30.2)
 *
 * Net-new, SEPARATE-origin static site that hosts the locked-down artifact render
 * page. Untrusted artifact code (agent- or human-authored HTML/JS) runs ONLY
 * here, in a cross-origin sandboxed iframe embedded by the app — never on the app
 * origin (which holds the user's session cookies). This stack is intentionally
 * decoupled from the app/ECS stack so the two never share an origin.
 *
 * Components:
 *  - A private S3 bucket holding the static host page (`/render`).
 *  - A CloudFront distribution (Origin Access Control; no public bucket ACLs)
 *    serving the host page with a STRICT Content-Security-Policy response header
 *    (`default-src 'none'; connect-src 'none'; script-src 'unsafe-inline'
 *    <allowlisted CDNs>; ...`). connect-src 'none' blocks network exfiltration;
 *    the CSP is widened ONLY for explicitly permitted CDN origins.
 *  - The host page is rendered at deploy time with the app origins allowed to
 *    post render messages baked in (parent-origin allowlist) and the same CSP as
 *    a <meta> fallback.
 *
 * The distribution domain is written to SSM so the app stack / deploy can wire it
 * into `ATRIUM_SANDBOX_ORIGIN` (and the `NEXT_PUBLIC_` mirror). NO app cookies are
 * ever in scope here.
 */
export interface AtriumSandboxStackProps extends cdk.StackProps {
  environment: 'dev' | 'prod';
  /**
   * App origins allowed to embed this sandbox and post render messages to it
   * (the parent-origin allowlist baked into the host page). e.g.
   * ['https://dev.aistudio.psd401.ai']. When empty, no parent can drive the
   * sandbox (it renders the waiting state) — fail closed.
   */
  allowedParentOrigins: string[];
  /**
   * CDN origins the sandbox CSP permits for `script-src` / `style-src` (e.g.
   * ['https://cdnjs.cloudflare.com']). Empty = inline-only artifacts.
   */
  allowedArtifactCdns?: string[];
}

export class AtriumSandboxStack extends cdk.Stack {
  /** The CloudFront domain serving the sandbox host (e.g. dxxxx.cloudfront.net). */
  public readonly sandboxDomainName: string;
  /** The full origin (https://<domain>) for ATRIUM_SANDBOX_ORIGIN. */
  public readonly sandboxOrigin: string;

  constructor(scope: Construct, id: string, props: AtriumSandboxStackProps) {
    super(scope, id, props);

    const isProd = props.environment === 'prod';
    const cdns = props.allowedArtifactCdns ?? [];

    // Normalize origins to canonical scheme+host (no trailing slash, no path).
    // Browsers report event.origin without a trailing slash or path component;
    // the isAllowedOrigin check in render.html does exact string equality.
    // A trailing slash passed here would silently break postMessage delivery.
    function normalizeOriginStr(raw: string): string {
      try { return new URL(raw).origin; } catch { return raw; }
    }
    const normalizedParentOrigins = props.allowedParentOrigins.map(normalizeOriginStr);

    // STRICT CSP for the sandbox host. connect-src 'none' blocks first-party API
    // calls / exfiltration; script-src/style-src widen ONLY for allowlisted CDNs.
    // img-src is intentionally restricted to data: only (no https: wildcard) to
    // prevent artifact code from using pixel-tracker images for data exfiltration
    // to arbitrary HTTPS hosts. Artifacts that need to display images must embed
    // them inline (data URLs) or load from an explicitly allowlisted CDN.
    // frame-ancestors restricts who can embed the host to the allowed parent origins.
    const scriptSrc = ["'unsafe-inline'", ...cdns].join(' ');
    const imgSrc = cdns.length > 0
      ? `data: ${cdns.join(' ')}`  // allowlisted CDN images + data URLs
      : "data:";                   // data URIs only when no CDNs configured
    const frameAncestors =
      normalizedParentOrigins.length > 0
        ? normalizedParentOrigins.join(' ')
        : "'none'";
    const cspPolicy = [
      "default-src 'none'",
      `script-src ${scriptSrc}`,
      "style-src 'unsafe-inline'",
      `img-src ${imgSrc}`,
      'font-src data:',
      "connect-src 'none'",
      `frame-ancestors ${frameAncestors}`,
      "base-uri 'none'",
      "form-action 'none'",
      "worker-src 'none'",
    ].join('; ');

    // Render the static host page with deploy-time substitutions: the parent
    // origin allowlist (JSON) and the CSP meta fallback. Generating the file
    // contents here (rather than fragile in-bucket token replacement) keeps the
    // served asset deterministic and reviewable.
    const templatePath = path.join(__dirname, '..', 'sandbox-host', 'render.html');
    const template = fs.readFileSync(templatePath, 'utf8');
    // replaceAll (not replace): guard against a future edit reintroducing the
    // token elsewhere in the template — replace() would substitute only the first.
    const renderedHtml = template
      .replaceAll('__ALLOWED_PARENT_ORIGINS__', JSON.stringify(normalizedParentOrigins))
      .replaceAll('__CSP_POLICY__', cspPolicy);

    // Private bucket; CloudFront reads it via Origin Access Control. No public
    // ACLs — the only way to reach the host page is through the distribution
    // (which applies the CSP + caching).
    const hostBucket = new s3.Bucket(this, 'SandboxHostBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
    });

    // Response headers policy applying the strict CSP (plus hardening headers) to
    // every response from the distribution. This is the AUTHORITATIVE CSP for the
    // sandbox host (the <meta> in the page is only a local-preview fallback).
    const responseHeaders = new cloudfront.ResponseHeadersPolicy(
      this,
      'SandboxResponseHeaders',
      {
        responseHeadersPolicyName: `atrium-sandbox-csp-${props.environment}-${cdk.Aws.REGION}`,
        comment: 'Strict CSP for the Atrium artifact sandbox host (#1052)',
        securityHeadersBehavior: {
          contentSecurityPolicy: { contentSecurityPolicy: cspPolicy, override: true },
          contentTypeOptions: { override: true },
          // X-Frame-Options is intentionally OMITTED: SAMEORIGIN or DENY would block
          // the cross-origin app from embedding this sandbox in an iframe. Embedding
          // is already restricted to the allowed parent origins via the CSP
          // frame-ancestors directive above (which is origin-precise and takes
          // precedence over X-Frame-Options in all modern browsers). Older browsers
          // that ignore frame-ancestors also cannot read app cookies from this
          // cross-origin host, so the security boundary holds either way.
          referrerPolicy: {
            referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER,
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAge: cdk.Duration.days(365),
            includeSubdomains: true,
            override: true,
          },
        },
      }
    );

    const distribution = new cloudfront.Distribution(this, 'SandboxDistribution', {
      comment: `Atrium artifact sandbox origin (${props.environment})`,
      defaultRootObject: 'render.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(hostBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: responseHeaders,
      },
      // Serve the host page at both `/` and `/render` (the app points the iframe
      // at `${origin}/render`). render.html is the only object in the bucket.
      additionalBehaviors: {
        '/render': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(hostBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          responseHeadersPolicy: responseHeaders,
        },
      },
      // `/render` (no extension) must resolve to render.html. CloudFront does not
      // append an index for non-root paths, so map the path to the object via a
      // CloudFront Function on viewer-request.
    });

    // Rewrite the extensionless `/render` request to `/render.html` so the single
    // host object is served at the path the app's iframe src uses.
    const rewriteFn = new cloudfront.Function(this, 'SandboxPathRewrite', {
      comment: 'Rewrite /render to /render.html for the Atrium sandbox host',
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var request = event.request;',
          "  if (request.uri === '/render' || request.uri === '/render/') {",
          "    request.uri = '/render.html';",
          '  }',
          '  return request;',
          '}',
        ].join('\n')
      ),
    });
    // Attach the rewrite to the /render behavior.
    // L1 escape: the CloudFront L2 `Distribution` construct does not expose
    // FunctionAssociations on non-default (additional) behaviors. We access the
    // underlying CfnDistribution via `node.defaultChild` to add it via a property
    // override. This is an intentional, scope-limited L1 escape — no other L1
    // properties are modified.
    const cfnDist = distribution.node.defaultChild as cloudfront.CfnDistribution;
    // The additional behavior for /render is index 0 in CacheBehaviors.
    cfnDist.addPropertyOverride('DistributionConfig.CacheBehaviors.0.FunctionAssociations', [
      {
        EventType: 'viewer-request',
        FunctionARN: rewriteFn.functionArn,
      },
    ]);

    // Deploy the rendered host page. Invalidate on deploy so a CSP / allowlist
    // change is served immediately rather than waiting for the cache TTL.
    new s3deploy.BucketDeployment(this, 'SandboxHostDeployment', {
      destinationBucket: hostBucket,
      sources: [s3deploy.Source.data('render.html', renderedHtml)],
      distribution,
      distributionPaths: ['/render.html', '/render', '/'],
      prune: true,
    });

    this.sandboxDomainName = distribution.distributionDomainName;
    this.sandboxOrigin = `https://${distribution.distributionDomainName}`;

    // Publish the origin for the app deploy to read into ATRIUM_SANDBOX_ORIGIN /
    // NEXT_PUBLIC_ATRIUM_SANDBOX_ORIGIN.
    new ssm.StringParameter(this, 'SandboxOriginParam', {
      parameterName: `/aistudio/${props.environment}/atrium-sandbox-origin`,
      stringValue: this.sandboxOrigin,
      description: 'Atrium artifact sandbox origin (separate-origin static host)',
    });

    new cdk.CfnOutput(this, 'AtriumSandboxOrigin', {
      value: this.sandboxOrigin,
      description: 'Atrium artifact sandbox origin (set as ATRIUM_SANDBOX_ORIGIN)',
    });
    new cdk.CfnOutput(this, 'AtriumSandboxDistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution id for the Atrium sandbox host',
    });
  }
}
