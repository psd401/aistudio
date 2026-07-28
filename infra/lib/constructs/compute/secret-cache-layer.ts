import * as cdk from "aws-cdk-lib"
import * as lambda from "aws-cdk-lib/aws-lambda"
import { Construct } from "constructs"
import * as path from "node:path"
import { execSync } from "node:child_process"

/**
 * Props for SecretCacheLayer construct
 */
export interface SecretCacheLayerProps {
  /**
   * Description for the layer
   * @default "Secret cache layer for AWS Lambda"
   */
  readonly description?: string

  /**
   * Compatible Lambda runtimes
   * @default [NODEJS_18_X, NODEJS_20_X]
   */
  readonly compatibleRuntimes?: lambda.Runtime[]

  /**
   * Layer name
   * @default "secret-cache-layer"
   */
  readonly layerName?: string
}

/**
 * Lambda Layer for Secret Caching
 *
 * Provides the secret-cache module as a Lambda layer that can be attached
 * to any Lambda function to enable in-memory secret caching.
 *
 * Features:
 * - Automatic bundling of TypeScript code
 * - Compatible with Node.js 18 and 20 runtimes
 * - Includes all necessary dependencies
 * - Versioned for cache busting
 *
 * @example
 * ```typescript
 * const secretCacheLayer = new SecretCacheLayer(this, 'SecretCacheLayer')
 *
 * const myFunction = new lambda.Function(this, 'MyFunction', {
 *   // ... other props
 *   layers: [secretCacheLayer.layer]
 * })
 * ```
 */
export class SecretCacheLayer extends Construct {
  public readonly layer: lambda.LayerVersion

  constructor(scope: Construct, id: string, props: SecretCacheLayerProps = {}) {
    super(scope, id)

    // Compile the layer from its TypeScript source at synth time, so a stale
    // committed index.js can never ship (previously the directory was deployed
    // as-is and required a manual pre-deploy build). The compiled index.js
    // lands at the asset root, preserving the existing /opt/index.js layout;
    // its only runtime dependency (@aws-sdk/client-secrets-manager) comes from
    // the Node.js Lambda runtime, so no node_modules are vendored.
    const layerPath = path.join(__dirname, "../../../lambdas/layers/secret-cache/nodejs")

    this.layer = new lambda.LayerVersion(this, "Layer", {
      code: lambda.Code.fromAsset(layerPath, {
        assetHashType: cdk.AssetHashType.SOURCE,
        // bun.lock is a hash input: it pins the build toolchain versions
        exclude: ["node_modules", "dist", "*.js", "*.d.ts"],
        bundling: {
          image: lambda.Runtime.NODEJS_20_X.bundlingImage,
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                execSync("bun install --frozen-lockfile && bunx tsc", { cwd: layerPath, stdio: "inherit" })
                execSync(`cp -r dist/* ${outputDir}/`, { cwd: layerPath, stdio: "inherit" })
                execSync(`cp package.json ${outputDir}/`, { cwd: layerPath, stdio: "inherit" })
                return true
              } catch (error) {
                process.stderr.write(
                  `Local secret-cache bundling failed; falling back to Docker: ${String(error)}\n`
                )
                return false
              }
            },
          },
          command: [
            "bash", "-c",
            "npm install && npm run build && cp -r dist/* /asset-output/ && cp package.json /asset-output/",
          ],
        },
      }),
      compatibleRuntimes:
        props.compatibleRuntimes || [lambda.Runtime.NODEJS_18_X, lambda.Runtime.NODEJS_20_X],
      description: props.description || "Secret cache layer for AWS Lambda",
      layerVersionName: props.layerName || "secret-cache-layer",
    })

    // Output the layer ARN
    new cdk.CfnOutput(this, "LayerArn", {
      value: this.layer.layerVersionArn,
      description: "ARN of the Secret Cache Lambda Layer",
      exportName: `${cdk.Stack.of(this).stackName}-SecretCacheLayerArn`,
    })
  }
}
