import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { s3Store } from "@/lib/content/storage/s3-store";

describe("Atrium local snapshot storage", () => {
  let storageRoot: string;
  const previousRoot = process.env.ATRIUM_LOCAL_STORAGE_DIR;

  beforeEach(async () => {
    storageRoot = await mkdtemp(join(tmpdir(), "atrium-storage-test-"));
    process.env.ATRIUM_LOCAL_STORAGE_DIR = storageRoot;
  });

  afterEach(async () => {
    if (previousRoot === undefined) {
      delete process.env.ATRIUM_LOCAL_STORAGE_DIR;
    } else {
      process.env.ATRIUM_LOCAL_STORAGE_DIR = previousRoot;
    }
    await rm(storageRoot, { recursive: true, force: true });
  });

  it("round-trips text without contacting S3", async () => {
    const key = s3Store.key("local-object", 1, "source.md");

    await s3Store.putText(key, "# Local body", "text/markdown");

    await expect(s3Store.getText(key)).resolves.toBe("# Local body");
    await expect(s3Store.getTextBounded(key, 100)).resolves.toBe(
      "# Local body"
    );
    await expect(s3Store.getTextBounded(key, 2)).rejects.toBeDefined();
  });

  it("deletes only the requested object's local tree", async () => {
    const firstSource = s3Store.key("first-object", 1, "source.md");
    const firstRender = s3Store.key("first-object", 1, "render.html");
    const secondSource = s3Store.key("second-object", 1, "source.md");
    await s3Store.putText(firstSource, "first", "text/markdown");
    await s3Store.putText(firstRender, "<p>first</p>", "text/html");
    await s3Store.putText(secondSource, "second", "text/markdown");

    await expect(s3Store.deleteObjectTree("first-object")).resolves.toBe(2);
    await expect(s3Store.getText(firstSource)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(s3Store.getText(secondSource)).resolves.toBe("second");
  });
});
