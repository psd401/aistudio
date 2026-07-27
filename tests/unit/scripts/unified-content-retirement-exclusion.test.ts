/** @jest-environment node */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const retirementGateSources = [
  "lib/repositories/content-platform/legacy-retirement.ts",
  "scripts/db/finalize-unified-content-retirement.ts",
].map((path) => ({
  path,
  source: readFileSync(resolve(process.cwd(), path), "utf8"),
}));

describe.each(retirementGateSources)(
  "unified content retirement exclusions in $path",
  ({ source }) => {
    it("keeps excluded connector sources out of the verification denominator", () => {
      expect(source).toContain("WHERE status <> 'excluded'");
      expect(source).toContain(
        "COALESCE(item.metadata, '{}'::jsonb) ? 'migrationSourceKind'",
      );
      expect(source).toContain(
        "FROM repository_connector_sources connector_source",
      );
      expect(source).toContain("connector_source.status = 'unsupported'");
    });
  },
);
