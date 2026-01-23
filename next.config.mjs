/** @type {import('next').NextConfig} */

const nextConfig = {
  output: 'standalone', // Required for ECS Fargate deployment
  transpilePackages: ['recharts'], // Required for Turbopack to resolve recharts dynamic imports
  images: {
    remotePatterns: [
      // Add specific trusted domains for user avatars
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
  experimental: {
    serverComponentsExternalPackages: ['mammoth', 'pdf-parse', '@aws-sdk/lib-storage'], // Server-only packages with Node.js dependencies
    serverActions: {
      bodySizeLimit: '100mb', // Match the file upload limit from settings
    },
  },
  // Don't embed environment variables at build time
  // They will be available at runtime from the ECS container environment
  // webpack: (config, { buildId, dev, isServer, defaultLoaders, webpack }) => {
  //   // Add rule for wasm files
  //   config.resolve.extensions.push('.wasm');
  //   config.module.rules.push({
  //     test: /\.wasm$/,
  //     type: 'javascript/auto',
  //     // Use file-loader for wasm files
  //     use: [
  //       {
  //         loader: 'file-loader',
  //         options: {
  //           publicPath: '/_next/static/wasm',
  //           outputPath: 'static/wasm',
  //           name: '[name].[hash].[ext]',
  //         },
  //       },
  //     ],
  //   });
  //
  //   // Prevent bundling pdfjs-dist in client-side bundle if not needed there
  //   // or configure worker path
  //   config.plugins.push(
  //     new webpack.ProvidePlugin({
  //       // If you use pdfjs in the browser, configure the worker path
  //       // 'pdfjs-dist/build/pdf': [path.resolve(__dirname, 'node_modules/pdfjs-dist/build/pdf.js')],
  //       // 'pdfjs-dist/build/pdf.worker': [path.resolve(__dirname, 'node_modules/pdfjs-dist/build/pdf.worker.js')]
  //     })
  //   );
  //
  //   // Copy the pdfjs worker files to the static directory
  //   if (isServer) {
  //     config.plugins.push(
  //       new CopyPlugin({
  //         patterns: [
  //           {
  //             from: path.join(
  //               path.dirname(require.resolve('pdfjs-dist/package.json')),
  //               'legacy/build/pdf.worker.mjs'
  //             ),
  //             to: path.join(__dirname, '.next/server'),
  //           },
  //           // Optionally copy cmaps and standard_fonts if needed by server worker
  //           // {
  //           //   from: path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'cmaps'),
  //           //   to: path.join(__dirname, '.next/server/cmaps')
  //           // },
  //           // {
  //           //   from: path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts'),
  //           //   to: path.join(__dirname, '.next/server/standard_fonts')
  //           // },
  //         ],
  //       })
  //     );
  //   } else {
  //     // For client-side builds, you might need to copy to a static path 
  //     // accessible by the browser if you were using pdfjs-dist on the client.
  //     // Since we are only using it server-side for now, this might not be needed.
  //     // config.plugins.push(
  //     //   new CopyPlugin({
  //     //     patterns: [
  //     //       { from: 'node_modules/pdfjs-dist/build/pdf.worker.min.js', to: path.join(__dirname, 'public/pdfjs') },
  //     //     ],
  //     //   })
  //     // );
  //   }
  //
  //   // Important: return the modified config
  //   return config;
  // },
};

export default nextConfig; 