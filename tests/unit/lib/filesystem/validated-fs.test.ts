import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validatedFs,
  validatedFsPromises,
} from "@/lib/filesystem/validated-fs";

describe("validated filesystem facade", () => {
  it("allows reads and writes inside an OS temporary directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aistudio-validated-fs-"));
    const file = join(directory, "sample.txt");
    try {
      await validatedFsPromises.writeFile(file, "safe");
      expect(await validatedFsPromises.readFile(file, "utf8")).toBe("safe");
      expect(validatedFs.statSync(file).isFile()).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("allows the stable POSIX temp root used by local storage", async () => {
    const directory = await mkdtemp("/tmp/aistudio-validated-fs-");
    const file = join(directory, "sample.txt");
    try {
      await validatedFsPromises.writeFile(file, "safe");
      expect(await validatedFsPromises.readFile(file, "utf8")).toBe("safe");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects traversal outside the allowed roots before calling Node fs", async () => {
    const outside = "/var/aistudio-validated-fs-outside.txt";
    await expect(validatedFsPromises.readFile(outside, "utf8")).rejects.toThrow(
      "Refusing read"
    );
    expect(() => validatedFs.writeFileSync(outside, "unsafe")).toThrow(
      "Refusing write"
    );
  });
});
