/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  reactStrictMode: true,
  // Externalize Node.js-only packages from webpack bundling
  // winston uses 'os', 'fs' which aren't available in webpack context
  serverExternalPackages: ['winston', 'logform', '@colors/colors'],
  typescript: {
    ignoreBuildErrors: true,
  },
  output: 'standalone',
  images: {
    remotePatterns: [],
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
            key: 'X-XSS-Protection',
            value: '1; mode=block'
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin'
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=()'
          },
          {
            key: 'Content-Security-Policy',
            value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.amazonaws.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; connect-src 'self' https://*.amazonaws.com wss://*.amazonaws.com https://api.anthropic.com https://api.openai.com; frame-src 'self' https://www.canva.com; frame-ancestors 'none';"
          }
        ],
      },
    ];
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '100mb', // Match the file upload limit from settings
      // Increase the timeout for server actions
      timeout: 300
    },
  },
  webpack: (config, { isServer }) => {
    // Modify cache configuration
    config.cache = {
      type: 'memory',
      maxGenerations: 1,
    };

    // Externalize Node.js-only packages for server builds
    // These packages use 'os', 'fs', 'stream', etc. which cause issues in instrumentation bundling
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push({
        'winston': 'commonjs winston',
        'logform': 'commonjs logform',
        '@colors/colors': 'commonjs @colors/colors',
        'postgres': 'commonjs postgres',
      });
    }

    return config;
  },
};

module.exports = nextConfig;
