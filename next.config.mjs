/** @type {import('next').NextConfig} */

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

// Atrium artifact sandbox (#1052): the app embeds an <iframe> pointing at a
// SEPARATE origin that runs untrusted artifact code (spec §19.2/§28.1). The app's
// own CSP `frame-src` must explicitly allow that origin, or the browser blocks the
// frame. We add it only when configured, and only after validating it is an
// absolute http(s) origin (never a wildcard — the frame source must be exact).
function resolveSandboxFrameOrigin() {
  const raw = process.env.NEXT_PUBLIC_ATRIUM_SANDBOX_ORIGIN || process.env.ATRIUM_SANDBOX_ORIGIN
  if (!raw) return null
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return url.origin
  } catch {
    return null
  }
}
const SANDBOX_FRAME_ORIGIN = resolveSandboxFrameOrigin()
const frameSrc = ["'self'", 'https://www.canva.com', ...(SANDBOX_FRAME_ORIGIN ? [SANDBOX_FRAME_ORIGIN] : [])].join(' ')

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
          },
          {
            key: 'Content-Security-Policy',
            value: `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.amazonaws.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; connect-src 'self' https://*.amazonaws.com wss://*.amazonaws.com https://api.anthropic.com https://api.openai.com; frame-src ${frameSrc}; frame-ancestors 'none';`
          }
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
