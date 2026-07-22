/**
 * Loads the synthesized embedding-generator artifact in the same Linux/x64
 * Node.js major version used by its Lambda and exercises both Bedrock payload
 * contracts. This catches missing production dependencies and packaging drift.
 *
 * Prerequisite:
 *   cd infra && bunx cdk synth AIStudio-ProcessingStack-Dev
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url))
);
const cdkOutput = join(repositoryRoot, "infra", "cdk.out");
const candidates = readdirSync(cdkOutput, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("asset."))
  .map((entry) => join(cdkOutput, entry.name))
  .filter((directory) => {
    const packagePath = join(directory, "package.json");
    const entryPath = join(directory, "index.js");
    if (!existsSync(packagePath) || !existsSync(entryPath)) return false;
    try {
      return (
        (JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown })
          .name === "embedding-generator" &&
        readFileSync(entryPath, "utf8").includes(
          "buildBedrockEmbeddingBodyForRuntimeSmoke"
        )
      );
    } catch {
      return false;
    }
  })
  .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);

const assetDirectory = candidates[0];
if (!assetDirectory) {
  throw new Error(
    "No synthesized embedding-generator Lambda asset was found; synthesize AIStudio-ProcessingStack-Dev first"
  );
}
for (const dependency of [
  "@aws-sdk/client-bedrock-runtime",
  "@aws-sdk/client-s3",
  "@aws-sdk/client-secrets-manager",
  "drizzle-orm",
  "openai",
  "postgres",
]) {
  if (!existsSync(join(assetDirectory, "node_modules", dependency))) {
    throw new Error(
      `Synthesized embedding artifact is missing production dependency ${dependency}`
    );
  }
}

const probe = [
  'const worker = require("/var/task/index.js");',
  'if (typeof worker.handler !== "function") throw new Error("Embedding handler export is missing");',
  'if (worker.normalizeEmbeddingProviderForRuntimeSmoke("amazon-bedrock") !== "amazon-bedrock") throw new Error("Bedrock provider configuration is unsupported in the deployed artifact");',
  'const titan = JSON.parse(worker.buildBedrockEmbeddingBodyForRuntimeSmoke("amazon.titan-embed-text-v1", "artifact text", 1536));',
  'if (titan.inputText !== "artifact text") throw new Error("Titan payload contract failed");',
  'const cohere = JSON.parse(worker.buildCohereMultimodalEmbeddingBodyForRuntimeSmoke("cohere.embed-v4:0", { text: "artifact image", imageDataUri: "data:image/png;base64,AQID" }, 1536));',
  'if (cohere.inputs?.[0]?.content?.[1]?.type !== "image_url") throw new Error("Cohere multimodal payload contract failed");',
  'const vector = worker.parseEmbeddingVectorForRuntimeSmoke({ embeddings: { float: [[0.1, 0.2]] } }, 2, "cohere.embed-v4:0");',
  'if (vector.length !== 2) throw new Error("Cohere response contract failed");',
  'process.stdout.write("EMBEDDING_LAMBDA_ARTIFACT_SMOKE_OK\\n");',
].join(" ");
const result = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "-e",
    "AWS_REGION=us-east-1",
    "-e",
    "DOCUMENTS_BUCKET_NAME=artifact-smoke",
    "-e",
    "DATABASE_HOST=database.invalid",
    "-e",
    "DATABASE_SECRET_ARN=arn:aws:secretsmanager:us-east-1:123456789012:secret:artifact-smoke",
    "-e",
    "DATABASE_NAME=aistudio",
    "-e",
    "DATABASE_PORT=5432",
    "-v",
    `${assetDirectory}:/var/task:ro`,
    "--entrypoint",
    "/var/lang/bin/node",
    "public.ecr.aws/lambda/nodejs:20",
    "--eval",
    probe,
  ],
  { encoding: "utf8" }
);

if (
  result.status !== 0 ||
  !result.stdout.includes("EMBEDDING_LAMBDA_ARTIFACT_SMOKE_OK")
) {
  throw new Error(
    [
      `Embedding Lambda artifact smoke failed with exit code ${result.status ?? "unknown"}`,
      result.stdout.trim(),
      result.stderr.trim(),
    ]
      .filter(Boolean)
      .join("\n")
  );
}
process.stdout.write(result.stdout);
