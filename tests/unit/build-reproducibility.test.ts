
import { join } from "node:path";
import { validatedFs } from "@/lib/filesystem/validated-fs";

const projectFile = (...segments: string[]) => join(process.cwd(), ...segments);

describe("production build reproducibility", () => {
  it("uses checked-in font assets instead of build-time Google downloads", () => {
    for (const modulePath of [
      ["lib", "fonts.ts"],
      ["lib", "atrium", "meridian-fonts.ts"],
    ]) {
      const source = validatedFs.readFileSync(projectFile(...modulePath), "utf8");
      expect(source).toContain("next/font/local");
      expect(source).not.toContain("next/font/google");
    }

    for (const asset of [
      "Inter-Variable.woff2",
      "SchibstedGrotesk-Variable.woff2",
      "OFL.txt",
    ]) {
      expect(validatedFs.statSync(projectFile("public", "fonts", asset)).size).toBeGreaterThan(0);
    }
  });

  it("bounds worker concurrency and leaves cache management to Next", () => {
    const source = validatedFs.readFileSync(projectFile("next.config.mjs"), "utf8");

    expect(source).toMatch(/cpus:\s*2/);
    expect(source).not.toMatch(/config\.cache\s*=/);
  });
});
