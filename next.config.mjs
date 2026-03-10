/** @type {import('next').NextConfig} */

// Scope S3 image remote patterns to the application's own bucket/region
// so next/image optimization cannot be used to proxy arbitrary S3 content.
const S3_BUCKET = process.env.DOCUMENTS_BUCKET_NAME || process.env.S3_BUCKET || 'aistudio-documents'
const AWS_REGION = process.env.NEXT_PUBLIC_AWS_REGION || process.env.AWS_REGION || 'us-east-1'

const nextConfig = {
  reactCompiler: true,
  reactStrictMode: true,
  output: 'standalone',
  transpilePackages: ['recharts'],
  serverExternalPackages: ['winston', 'logform', '@colors/colors', 'argon2', 'postgres', 'mammoth', 'pdf-parse', 'oidc-provider'],
  outputFileTracingIncludes: {
    '/**': [
      './node_modules/argon2/**/*',
      './node_modules/@phc/format/**/*',
      './node_modules/node-gyp-build/**/*',
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
      {
        protocol: 'https',
        hostname: `${S3_BUCKET}.s3.${AWS_REGION}.amazonaws.com`,
      },
      {
        protocol: 'https',
        hostname: `${S3_BUCKET}.s3.amazonaws.com`,
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
