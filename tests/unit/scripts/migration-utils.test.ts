/** @jest-environment node */

import fs from "node:fs";
import { describe, expect, it } from "@jest/globals";
import {
  getAbsolutePath,
  getNextMigrationNumber,
} from "@/scripts/drizzle-helpers/lib/migration-utils";

interface MigrationManifest {
  migrationFiles: string[];
}

describe("migration utilities", () => {
  it("derives the next number from the shared migrations manifest", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        getAbsolutePath("infra/database/migrations.json"),
        "utf8"
      )
    ) as MigrationManifest;
    const highest = Math.max(
      9,
      ...manifest.migrationFiles.map((filename) =>
        Number.parseInt(filename.match(/^(\d+)/)?.[1] ?? "0", 10)
      )
    );

    expect(getNextMigrationNumber()).toBe(highest + 1);
  });
});
