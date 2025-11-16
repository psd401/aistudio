/** @type {import('next').NextConfig} */
const path = require('path');

const nextConfig = {
  reactStrictMode: true,
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
            value: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.amazonaws.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; connect-src 'self' https://*.amazonaws.com wss://*.amazonaws.com https://api.anthropic.com https://api.openai.com; frame-ancestors 'none';"
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
  webpack: (config) => {
    // Modify cache configuration
    config.cache = {
      type: 'memory',
      maxGenerations: 1,
    };
    
    return config;
  },
};

module.exports = nextConfig;
