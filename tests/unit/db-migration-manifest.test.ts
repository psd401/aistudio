/**
 * Migration-manifest registration guard (Epic #1202 Phase 2, #1205 review).
 *
 * `infra/database/migrations.json` is the SINGLE source of truth for which
 * schema files execute: `scripts/db/run-migrations.ts` (local) and
 * `infra/database/lambda/db-init-handler.ts` (deploy) iterate ONLY its
 * `initialSetupFiles` + `migrationFiles` arrays — there is no directory-scan
 * fallback. A schema file that exists on disk but is not listed is silently
 * never run (exactly what happened to 110-atrium-group-grant-kind.sql in the
 * first cut of #1205: the `ALTER TYPE grant_kind ADD VALUE 'group'` would have
 * been dead on arrival in every environment). This test makes that failure
 * mode impossible to reintroduce.
 */

import fs from "fs";
import path from "path";

const manifestPath = path.join(process.cwd(), "infra/database/migrations.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
  schemaDir: string;
  initialSetupFiles: string[];
  migrationFiles: string[];
};
const schemaDir = path.join(process.cwd(), manifest.schemaDir);
const listed = [...manifest.initialSetupFiles, ...manifest.migrationFiles];

describe("infra/database/migrations.json manifest", () => {
  it("registers every schema .sql file (rollback scripts are the only exception)", () => {
    const onDisk = fs
      .readdirSync(schemaDir)
      // *-rollback.sql are operator-run recovery scripts, deliberately never
      // part of the forward migration sequence.
      .filter((f) => f.endsWith(".sql") && !f.endsWith("-rollback.sql"));
    const unregistered = onDisk.filter((f) => !listed.includes(f));
    expect(unregistered).toEqual([]);
  });

  it("lists no file that is missing from the schema directory", () => {
    const missing = listed.filter(
      (f) => !fs.existsSync(path.join(schemaDir, f))
    );
    expect(missing).toEqual([]);
  });

  it("lists no file twice (a duplicate would re-run a migration)", () => {
    const dupes = listed.filter((f, i) => listed.indexOf(f) !== i);
    expect(dupes).toEqual([]);
  });
});
