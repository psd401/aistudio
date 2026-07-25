import fs from "node:fs";
import path from "node:path";

describe("Atrium asset initiation idempotency migration", () => {
  const sql = fs.readFileSync(
    path.join(
      process.cwd(),
      "infra/database/schema/135-atrium-asset-initiation-idempotency.sql"
    ),
    "utf8"
  );

  it("stores only paired hashes and uniquely scopes them to an object", () => {
    expect(sql).toContain("initiation_key_hash VARCHAR(64)");
    expect(sql).toContain("initiation_request_hash VARCHAR(64)");
    expect(sql).toContain("ck_content_asset_initiation_hashes");
    expect(sql).toMatch(
      /UNIQUE INDEX IF NOT EXISTS uq_content_assets_initiation_key\s+ON content_assets \(object_id, initiation_key_hash\)/
    );
    expect(sql).toContain("WHERE initiation_key_hash IS NOT NULL");
  });
});
