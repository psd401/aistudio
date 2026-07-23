/** @jest-environment node */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "infra/database/schema/125-nexus-ephemeral-repositories.sql"
  ),
  "utf8"
);

describe("Nexus ephemeral repository migration", () => {
  it("backfills Repository Manager access for the existing staff audience", () => {
    expect(migration).toMatch(
      /INSERT INTO role_capabilities \(role_id, capability_id\)/
    );
    expect(migration).toContain(
      "c.identifier = 'knowledge-repositories'"
    );
    expect(migration).toContain("r.name = 'staff'");
    expect(migration).toContain(
      "ON CONFLICT (role_id, capability_id) DO NOTHING"
    );
  });

  it("enforces private expiring ephemeral repositories", () => {
    expect(migration).toContain(
      "CONSTRAINT chk_knowledge_repositories_ephemeral_policy"
    );
    expect(migration).toMatch(/repository_kind <> 'ephemeral'/);
    expect(migration).toMatch(/is_public IS FALSE/);
    expect(migration).toMatch(/retention_days IS NOT NULL/);
    expect(migration).toMatch(/expires_at IS NOT NULL/);
    expect(migration).toMatch(
      /UPDATE knowledge_repositories[\s\S]*repository_kind = 'ephemeral'/
    );
    expect(migration).toMatch(/lifecycle_status = CASE/);
    expect(migration).toMatch(
      /VALIDATE CONSTRAINT chk_knowledge_repositories_ephemeral_policy/
    );
  });

  it("binds drafts, conversations, and repositories through owner-safe foreign keys", () => {
    expect(migration).toMatch(
      /UNIQUE INDEX IF NOT EXISTS uq_knowledge_repositories_id_owner[\s\S]*\(id, owner_id\)/
    );
    expect(migration).toMatch(
      /UNIQUE INDEX IF NOT EXISTS uq_nexus_conversations_id_user[\s\S]*\(id, user_id\)/
    );
    expect(migration).toMatch(
      /FOREIGN KEY \(conversation_id, owner_id\)[\s\S]*REFERENCES nexus_conversations\(id, user_id\)/
    );
    expect(migration).toMatch(
      /FOREIGN KEY \(repository_id, owner_id\)[\s\S]*REFERENCES knowledge_repositories\(id, owner_id\)/
    );
    expect(migration).toMatch(/UNIQUE \(owner_id, draft_key\)/);
    expect(migration).toMatch(/UNIQUE \(repository_id\)/);
  });

  it("keeps lifecycle timestamps current for retry-safe purge leases", () => {
    expect(migration).toContain(
      "CREATE TRIGGER trg_nexus_repository_bindings_updated_at"
    );
    expect(migration).toContain(
      "FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()"
    );
  });
});
