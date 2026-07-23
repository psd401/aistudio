import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** @type {import('next').NextConfig} */

const PROJECT_ROOT = path.dirname(fileURLToPath(import.meta.url))

// Bun's isolated linker can install multiple physical copies of CodeMirror's
// state/view packages, even when they resolve to the same version. CodeMirror
// relies on instanceof checks for extension values, so bundling more than one
// copy crashes the editor at runtime. Pin both bundlers to the root copies so
// every CodeMirror extension shares the same module identity.
const codeMirrorAliases = {
  '@codemirror/state': './node_modules/@codemirror/state',
  '@codemirror/view': './node_modules/@codemirror/view',
}

// Scope S3 image remote patterns to the application's own bucket/region
// so next/image optimization cannot be used to proxy arbitrary S3 content.
// Patterns are omitted entirely when the env var is absent to avoid pointing
// at a wrong bucket in new deployments.
const S3_BUCKET = process.env.DOCUMENTS_BUCKET_NAME || process.env.S3_BUCKET
const AWS_REGION = process.env.NEXT_PUBLIC_AWS_REGION || process.env.AWS_REGION || 'us-east-1'

// Build S3 remote patterns only when the bucket name is explicitly configured
const s3RemotePatterns = S3_BUCKET
  ? [
      { protocol: 'https', hostname: `${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com` },
      { protocol: 'https', hostname: `${S3_BUCKET}.s3.amazonaws.com` },
    ]
  : []

// NOTE (#1052): the Content-Security-Policy header is intentionally NOT set here.
// next.config `headers()` is evaluated at BUILD time, but the Atrium artifact
// sandbox origin (`ATRIUM_SANDBOX_ORIGIN`) is only known at DEPLOY time (a
// CloudFront domain injected by the CDK AtriumSandboxStack). Multiple CSP headers
// combine by intersection, so the policy must have a single source — it is built
// at request time in `middleware.ts`, which can read the runtime env. Do NOT
// re-add a `Content-Security-Policy` entry below, or it will intersect with the
// middleware policy and silently block the sandbox `frame-src`.

const nextConfig = {
  reactCompiler: true,
  reactStrictMode: true,
  output: 'standalone',
  // Allow an isolated build directory (default '.next'). The local E2E runner
  // builds a production bundle to '.next-e2e' so it can run a prod server on a
  // dedicated port WITHOUT clobbering a developer's running `next dev` (.next),
  // and without the dev server's lazy per-route compilation falling over under
  // parallel Playwright load. See scripts/test/e2e-local.sh.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  transpilePackages: ['recharts'],
  turbopack: {
    resolveAlias: codeMirrorAliases,
  },
  serverExternalPackages: ['winston', 'logform', '@colors/colors', 'argon2', 'postgres', 'mammoth', 'pdf-parse', 'oidc-provider', 'ws',
    // Atrium collab (#1051): the agent-bridge route opens a y-websocket client to
    // the collab server. These pure-ESM Yjs libs must run as real Node modules on
    // the server, not webpack-bundled (bundling breaks the y-websocket client —
    // it connects but never syncs). Server-only; the browser editor still bundles them.
    'y-websocket', 'yjs', 'y-prosemirror', 'y-protocols', 'lib0'],
  outputFileTracingIncludes: {
    '/**': [
      './node_modules/argon2/**/*',
      './node_modules/@phc/format/**/*',
      './node_modules/node-gyp-build/**/*',
      './node_modules/ws/**/*',
      './node_modules/@google/genai/**/*',
    ],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'avatars.githubusercontent.com',
      },
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
      },
      ...s3RemotePatterns,
    ]
  },
  devIndicators: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'X-Frame-Options',
            value: 'DENY'
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff'
          },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains'
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin'
          },
          {
            key: 'Permissions-Policy',
            // microphone=(self) required for voice mode (Issue #872).
            // Applies globally — voice pages need mic access, other pages
            // won't trigger the permission prompt unless they call getUserMedia.
            value: 'camera=(), microphone=(self), geolocation=()'
          }
          // Content-Security-Policy is set in middleware.ts (runtime) — see note
          // at the top of this file (#1052).
        ],
      },
    ];
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '100mb',
      timeout: 300,
    },
    // Enables the `forbidden()` / `unauthorized()` navigation interrupts used by
    // the Atrium reader (app/(protected)/c/[slug]) to return a true 403 for
    // out-of-audience users (#1051).
    authInterrupts: true,
  },
  webpack: (config, { isServer }) => {
    config.cache = {
      type: 'memory',
      maxGenerations: 1,
    };

    config.resolve.alias = {
      ...config.resolve.alias,
      '@codemirror/state': path.join(PROJECT_ROOT, 'node_modules/@codemirror/state'),
      '@codemirror/view': path.join(PROJECT_ROOT, 'node_modules/@codemirror/view'),
    };

    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push({
        'winston': 'commonjs winston',
        'logform': 'commonjs logform',
        '@colors/colors': 'commonjs @colors/colors',
        'postgres': 'commonjs postgres',
        'argon2': 'commonjs argon2',
      });
    }

    return config;
  },
};

export default nextConfig;
