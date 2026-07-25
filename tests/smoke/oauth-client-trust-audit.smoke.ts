/**
 * OAuth client first-party trust real-database smoke.
 *
 * Proves migration 134's audit triggers remain compatible with the existing
 * INSERT ... ON CONFLICT credential-rotation path and record each privileged
 * trust change exactly once. All fixtures run inside a rolled-back transaction.
 *
 * Run:
 *   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/aistudio' DB_SSL=false \
 *     bun run test:smoke:oauth-client-trust-audit
 */

import assert from "node:assert/strict";
import postgres from "postgres";
import { scriptLogger as log } from "../../scripts/db/script-logger";

async function main(): Promise<void> {
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5432/aistudio";
  const sslEnabled = process.env.DB_SSL !== "false";
  const sql = postgres(databaseUrl, {
    ssl: sslEnabled ? "require" : false,
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
  });

  let transactionStarted = false;

  try {
    await sql`BEGIN`;
    transactionStarted = true;

    await sql`
    INSERT INTO oauth_clients (
      client_id,
      client_name,
      client_secret_hash,
      redirect_uris,
      allowed_scopes,
      grant_types,
      response_types,
      token_endpoint_auth_method,
      require_pkce,
      is_active
    )
    VALUES (
      'oauth-trust-audit-smoke-confidential',
      'OAuth trust audit confidential upsert smoke',
      'test-only-not-a-secret',
      '[]'::jsonb,
      '[]'::jsonb,
      '["client_credentials"]'::jsonb,
      '[]'::jsonb,
      'client_secret_basic',
      false,
      true
    )
    ON CONFLICT (client_id) DO UPDATE
    SET allowed_scopes = EXCLUDED.allowed_scopes
  `;

    await sql`
    INSERT INTO oauth_clients (
      client_id,
      client_name,
      client_secret_hash,
      redirect_uris,
      allowed_scopes,
      grant_types,
      response_types,
      token_endpoint_auth_method,
      require_pkce,
      is_active
    )
    VALUES (
      'oauth-trust-audit-smoke-confidential',
      'OAuth trust audit confidential upsert smoke',
      'test-only-not-a-secret',
      '[]'::jsonb,
      '[]'::jsonb,
      '["client_credentials"]'::jsonb,
      '[]'::jsonb,
      'client_secret_basic',
      false,
      true
    )
    ON CONFLICT (client_id) DO UPDATE
    SET allowed_scopes = EXCLUDED.allowed_scopes
  `;

    await sql`
    INSERT INTO oauth_clients (
      client_id,
      client_name,
      redirect_uris,
      allowed_scopes,
      grant_types,
      response_types,
      token_endpoint_auth_method,
      require_pkce,
      is_active,
      is_first_party
    )
    VALUES (
      'oauth-trust-audit-smoke-first-party',
      'OAuth trust audit first-party upsert smoke',
      '["https://smoke.invalid/callback"]'::jsonb,
      '["openid", "profile", "offline_access"]'::jsonb,
      '["authorization_code"]'::jsonb,
      '["code"]'::jsonb,
      'none',
      true,
      true,
      false
    )
    ON CONFLICT (client_id) DO UPDATE
    SET is_first_party = EXCLUDED.is_first_party
  `;

    for (const isFirstParty of [true, true]) {
      await sql`
      INSERT INTO oauth_clients (
        client_id,
        client_name,
        redirect_uris,
        allowed_scopes,
        grant_types,
        response_types,
        token_endpoint_auth_method,
        require_pkce,
        is_active,
        is_first_party
      )
      VALUES (
        'oauth-trust-audit-smoke-first-party',
        'OAuth trust audit first-party upsert smoke',
        '["https://smoke.invalid/callback"]'::jsonb,
        '["openid", "profile", "offline_access"]'::jsonb,
        '["authorization_code"]'::jsonb,
        '["code"]'::jsonb,
        'none',
        true,
        true,
        ${isFirstParty}
      )
      ON CONFLICT (client_id) DO UPDATE
      SET is_first_party = EXCLUDED.is_first_party
    `;
    }

    const [result] = await sql<
      {
        confidentialUpsertRows: number;
        confidentialAuditRows: number;
        firstPartyAuditRows: number;
        legacyAuditRules: number;
      }[]
    >`
    SELECT
      (
        SELECT COUNT(*)::integer
        FROM oauth_clients
        WHERE client_id = 'oauth-trust-audit-smoke-confidential'
      ) AS "confidentialUpsertRows",
      (
        SELECT COUNT(*)::integer
        FROM oauth_client_trust_audit
        WHERE client_id = 'oauth-trust-audit-smoke-confidential'
      ) AS "confidentialAuditRows",
      (
        SELECT COUNT(*)::integer
        FROM oauth_client_trust_audit
        WHERE client_id = 'oauth-trust-audit-smoke-first-party'
          AND previous_is_first_party = false
          AND new_is_first_party = true
          AND change_source = 'database-trigger-update'
      ) AS "firstPartyAuditRows",
      (
        SELECT COUNT(*)::integer
        FROM pg_rewrite
        WHERE rulename IN (
          'oauth_client_trust_audit_insert',
          'oauth_client_trust_audit_update'
        )
      ) AS "legacyAuditRules"
  `;

    assert.deepEqual(result, {
      confidentialUpsertRows: 1,
      confidentialAuditRows: 0,
      firstPartyAuditRows: 1,
      legacyAuditRules: 0,
    });
    log.success(
      "OAuth client upserts remain usable and first-party trust changes are audited once",
    );
  } finally {
    if (transactionStarted) {
      await sql`ROLLBACK`;
    }
    await sql.end();
  }
}

main().catch((error: unknown) => {
  log.error("OAuth client trust audit smoke failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
