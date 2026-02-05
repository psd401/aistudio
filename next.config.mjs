/** @type {import('next').NextConfig} */

const nextConfig = {
  reactCompiler: true,
  reactStrictMode: true,
  output: 'standalone',
  transpilePackages: ['recharts'],
  serverExternalPackages: ['winston', 'logform', '@colors/colors', 'argon2', 'postgres'],
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
      }
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
    serverComponentsExternalPackages: ['mammoth', 'pdf-parse', 'oidc-provider', 'argon2'],
    serverActions: {
      bodySizeLimit: '100mb',
      timeout: 300,
    },
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
