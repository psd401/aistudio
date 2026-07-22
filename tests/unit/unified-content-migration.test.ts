/** @jest-environment node */

import fs from "node:fs";
import path from "node:path";

const migrationPath = path.join(process.cwd(), "infra/database/schema/116-unified-repository-content.sql");
const sql = fs.readFileSync(migrationPath, "utf8");
const officeMigrationPath = path.join(process.cwd(), "infra/database/schema/117-unified-content-office-ingestion.sql");
const officeSql = fs.readFileSync(officeMigrationPath, "utf8");
const imageMigrationPath = path.join(process.cwd(), "infra/database/schema/118-unified-content-image-ingestion.sql");
const imageSql = fs.readFileSync(imageMigrationPath, "utf8");
const mediaMigrationPath = path.join(process.cwd(), "infra/database/schema/119-unified-content-media-ingestion.sql");
const mediaSql = fs.readFileSync(mediaMigrationPath, "utf8");
const embeddingMigrationPath = path.join(process.cwd(), "infra/database/schema/120-bedrock-repository-embeddings.sql");
const embeddingSql = fs.readFileSync(embeddingMigrationPath, "utf8");

describe("migration 116 unified repository content", () => {
  it.each([
    "repository_item_versions",
    "repository_upload_sessions",
    "repository_processing_jobs",
    "repository_artifacts",
    "repository_index_generations",
  ])("creates %s additively", (tableName) => {
    expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${tableName}`);
  });

  it("keeps canonical rollout flags disabled by default", () => {
    expect(sql).toContain("('CONTENT_PLATFORM_ENABLED', 'false'");
    expect(sql).toContain("('CONTENT_DUAL_WRITE_ENABLED', 'false'");
    expect(sql).toContain("('CONTENT_READ_V2_ENABLED', 'false'");
    expect(sql).toContain("('CONTENT_MAX_PDF_SIZE_MB', '500'");
  });

  it("enforces quarantine, job idempotency, and one active generation", () => {
    expect(sql).toContain("storage_status varchar(20) NOT NULL DEFAULT 'quarantined'");
    expect(sql).toContain("inspection_status varchar(20) NOT NULL DEFAULT 'pending'");
    expect(sql).toContain("uq_repository_processing_idempotency");
    expect(sql).toContain("uq_repository_artifact_key");
    expect(sql).toContain("uq_repository_chunks_generation_index");
    expect(sql).toContain("uq_repository_active_generation");
    expect(sql).toContain("WHERE status = 'active'");
  });

  it("does not use an unsupported dollar-quoted migration block", () => {
    expect(sql).not.toMatch(/^\s*DO \$\$/mu);
  });

  it("seeds an independent administrator-controlled Office processing limit", () => {
    expect(officeSql).toContain("('CONTENT_MAX_OFFICE_SIZE_MB', '100'");
    expect(officeSql).toContain("ON CONFLICT (key) DO NOTHING");
    expect(officeSql).not.toMatch(/^\s*DO \$\$/mu);
  });

  it("seeds bounded image processing and a Bedrock Nova captioner", () => {
    expect(imageSql).toContain("DROP CONSTRAINT IF EXISTS repository_items_type_check");
    expect(imageSql).toContain("CHECK (type IN ('document', 'url', 'text', 'image'))");
    expect(imageSql).toContain("('CONTENT_MAX_IMAGE_SIZE_MB', '50'");
    expect(imageSql).toContain("('CONTENT_IMAGE_CAPTION_MODEL_ID', 'us.amazon.nova-2-lite-v1:0'");
    expect(imageSql).toContain("ON CONFLICT (key) DO NOTHING");
    expect(imageSql).not.toMatch(/^\s*DO \$\$/mu);
  });

  it("adds canonical audio and video repository item types", () => {
    expect(mediaSql).toContain("CHECK (type IN ('document', 'url', 'text', 'image', 'audio', 'video'))");
    expect(mediaSql).toContain("'thumbnail', 'audio', 'video', 'transcript', 'caption'");
    expect(mediaSql).not.toMatch(/^\s*DO \$\$/mu);
  });

  it("seeds IAM-authenticated Bedrock repository embeddings", () => {
    expect(embeddingSql).toContain("'EMBEDDING_MODEL_PROVIDER', 'amazon-bedrock'");
    expect(embeddingSql).toContain("'amazon.titan-embed-text-v1'");
    expect(embeddingSql).toContain("value = 'text-embedding-3-small'");
    expect(embeddingSql).toContain("SELECT DISTINCT ON (repository.id) candidate.id");
    expect(embeddingSql).toContain("candidate.status = 'succeeded'");
    expect(embeddingSql).not.toContain("BEDROCK_ACCESS_KEY_ID");
    expect(embeddingSql).not.toMatch(/^\s*DO \$\$/mu);
  });
});
