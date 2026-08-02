/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";
import { stripComments } from "../helpers/strip-ts-comments";

const root = process.cwd();
const fileProcessorSource = stripComments(
  fs.readFileSync(
    path.join(root, "infra/lambdas/file-processor/index.ts"),
    "utf8",
  ),
);
const urlProcessorSource = stripComments(
  fs.readFileSync(
    path.join(root, "infra/lambdas/url-processor/index.ts"),
    "utf8",
  ),
);

describe("legacy processor embedding status honesty", () => {
  it("fails the item and job when the file embedding enqueue fails", () => {
    const enqueueStart = fileProcessorSource.indexOf(
      "Successfully queued ${chunkIds.length} chunks",
    );
    const catchStart = fileProcessorSource.indexOf(
      "} catch (error) {",
      enqueueStart,
    );
    const catchEnd = fileProcessorSource.indexOf("} else {", catchStart);
    expect(enqueueStart).toBeGreaterThanOrEqual(0);
    expect(catchStart).toBeGreaterThan(enqueueStart);
    expect(catchEnd).toBeGreaterThan(catchStart);

    const enqueueFailure = fileProcessorSource.slice(catchStart, catchEnd);
    expect(enqueueFailure).toMatch(
      /updateItemStatus\(\s*job\.itemId,\s*'embedding_failed',\s*'Embedding generation could not be queued\. Retry this item\.'\s*\)/,
    );
    expect(enqueueFailure).toMatch(
      /updateJobStatus\(\s*job\.jobId,\s*'failed'/,
    );
    expect(enqueueFailure).toContain("return;");
    expect(enqueueFailure).not.toMatch(
      /updateItemStatus\(\s*job\.itemId,\s*'completed'/,
    );
  });

  it("marks legacy URL chunks unsearchable without adding embedding wiring", () => {
    expect(urlProcessorSource).toMatch(
      /updateItemStatus\(\s*job\.itemId,\s*'embedding_failed',\s*'Legacy URL processing does not generate embeddings\. Retry this item\.'\s*\)/,
    );
    expect(urlProcessorSource).not.toMatch(
      /updateItemStatus\(\s*job\.itemId,\s*'completed'/,
    );
    expect(urlProcessorSource).not.toContain("EMBEDDING_QUEUE_URL");
  });
});
