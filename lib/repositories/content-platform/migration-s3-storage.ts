import { createHash } from "node:crypto";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type {
  MigrationStoredObject,
  RepositoryMigrationStorage,
} from "./migration-runner";

function isPreconditionFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    candidate.name === "PreconditionFailed" ||
    candidate.$metadata?.httpStatusCode === 412
  );
}

interface S3Body {
  transformToByteArray(): Promise<Uint8Array>;
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
}

async function objectBytesHash(body: S3Body): Promise<string> {
  const hash = createHash("sha256");
  const iterable = body as AsyncIterable<Uint8Array>;
  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of iterable) hash.update(chunk);
  } else {
    hash.update(await body.transformToByteArray());
  }
  return hash.digest("hex");
}

export function createS3RepositoryMigrationStorage(input: {
  bucket: string;
  client?: S3Client;
}): RepositoryMigrationStorage {
  const client = input.client ?? new S3Client({});

  const inspectObject = async (
    objectKey: string,
  ): Promise<MigrationStoredObject> => {
    const result = await client.send(
      new GetObjectCommand({ Bucket: input.bucket, Key: objectKey }),
    );
    if (!result.Body || result.ContentLength == null) {
      throw new Error("Migration source object is missing bytes or length");
    }
    return {
      byteSize: result.ContentLength,
      contentType: result.ContentType ?? null,
      sha256: await objectBytesHash(result.Body as S3Body),
    };
  };

  return {
    async inspectAndCopyObject({ sourceKey, targetKey }) {
      if (
        !sourceKey.trim() ||
        sourceKey.startsWith("/") ||
        sourceKey.includes("..")
      ) {
        throw new Error("Migration source object key is invalid");
      }
      const source = await inspectObject(sourceKey);
      if (sourceKey === targetKey) return source;
      const encodedSourceKey = sourceKey
        .split("/")
        .map((part) => encodeURIComponent(part))
        .join("/");
      try {
        await client.send(
          new CopyObjectCommand({
            Bucket: input.bucket,
            Key: targetKey,
            CopySource: `/${input.bucket}/${encodedSourceKey}`,
            IfNoneMatch: "*",
          }),
        );
      } catch (error) {
        if (!isPreconditionFailure(error)) throw error;
        const existing = await inspectObject(targetKey);
        if (existing.sha256 !== source.sha256) {
          throw new Error(
            "Deterministic migration target exists with different bytes",
            { cause: error },
          );
        }
        return existing;
      }
      // CopyObject preserves source metadata by default. Re-downloading and
      // hashing the target here would double migration transfer cost and make
      // large resumable batches far more likely to hit the Lambda timeout.
      return source;
    },

    async putObject({ targetKey, body, contentType, metadata }) {
      const expectedHash = createHash("sha256").update(body).digest("hex");
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: input.bucket,
            Key: targetKey,
            Body: body,
            ContentLength: body.byteLength,
            ContentType: contentType,
            Metadata: metadata,
            IfNoneMatch: "*",
          }),
        );
      } catch (error) {
        if (!isPreconditionFailure(error)) throw error;
        const existing = await inspectObject(targetKey);
        if (existing.sha256 !== expectedHash) {
          throw new Error(
            "Deterministic migration target exists with different bytes",
            { cause: error },
          );
        }
        return existing;
      }
      return {
        byteSize: body.byteLength,
        contentType,
        sha256: expectedHash,
      };
    },

    async deleteObject(objectKey) {
      await client.send(
        new DeleteObjectCommand({ Bucket: input.bucket, Key: objectKey }),
      );
    },
  };
}
