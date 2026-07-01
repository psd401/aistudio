/**
 * Seed Atrium autonomous agent identities + their client-credentials OIDC clients
 * (Issue #1055, Epic #1059, Atrium Phase 5 §10 / §26).
 *
 * Idempotent: re-running skips identities that are already bound to an OIDC
 * client. For each NEW identity it:
 *   1. inserts an `agent_identities` row (service|skill, scopes, staff role for
 *      visibility), NONE with content:publish_public,
 *   2. creates a `client_credentials` OIDC client (client_secret_basic, no PKCE,
 *      no redirect/response types, allowedScopes = the identity's scopes),
 *   3. links agent_identities.oauthClientId → the client, and
 *   4. prints the generated client_secret ONCE (store it in your secrets manager;
 *      it is never recoverable after this run).
 *
 * Run:  bunx tsx scripts/seed-atrium-agents.ts   (needs DATABASE_URL)
 */

import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { executeQuery, executeTransaction } from "@/lib/db/drizzle-client";
import { agentIdentities, oauthClients, roles, userRoles } from "@/lib/db/schema";
import { hashArgon2 } from "@/lib/api-keys/argon2-loader";
import type { ApiScope } from "@/lib/api-keys/scopes";

interface SeedAgent {
  name: string;
  kind: "service" | "skill";
  scopes: ApiScope[];
}

// Conservative scopes; NONE hold content:publish_public (the human-gated scope).
const SEED_AGENTS: SeedAgent[] = [
  { name: "ship-reporter", kind: "service", scopes: ["content:create", "content:publish_internal"] },
  { name: "screentime-bot", kind: "service", scopes: ["content:create", "content:publish_internal"] },
  { name: "tutorial-publisher", kind: "skill", scopes: ["content:create", "content:update"] },
];

async function staffRoleId(): Promise<number | null> {
  const rows = await executeQuery(
    (db) => db.select({ id: roles.id }).from(roles).where(eq(roles.name, "staff")).limit(1),
    "seedAtriumAgents.staffRole"
  );
  return rows[0]?.id ?? null;
}

async function existingIdentity(name: string) {
  const rows = await executeQuery(
    (db) =>
      db
        .select({ id: agentIdentities.id, oauthClientId: agentIdentities.oauthClientId })
        .from(agentIdentities)
        .where(eq(agentIdentities.name, name))
        .limit(1),
    "seedAtriumAgents.existing"
  );
  return rows[0] ?? null;
}

async function seedAgent(agent: SeedAgent, roleId: number | null): Promise<void> {
  const existing = await existingIdentity(agent.name);
  if (existing?.oauthClientId) {
    console.log(`✓ ${agent.name}: already bound to client ${existing.oauthClientId} — skipping`);
    return;
  }

  const clientId = `agent-${agent.name}`;
  const clientSecret = `cs-${randomBytes(32).toString("hex")}`;
  const clientSecretHash = await hashArgon2(clientSecret);

  await executeTransaction(async (tx) => {
    // Upsert the OIDC client (client-credentials, confidential).
    await tx
      .insert(oauthClients)
      .values({
        clientId,
        clientName: `Atrium agent: ${agent.name}`,
        clientSecretHash,
        redirectUris: [],
        responseTypes: [],
        allowedScopes: agent.scopes,
        grantTypes: ["client_credentials"],
        tokenEndpointAuthMethod: "client_secret_basic",
        requirePkce: false,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: oauthClients.clientId,
        set: {
          clientSecretHash,
          allowedScopes: agent.scopes,
          grantTypes: ["client_credentials"],
          tokenEndpointAuthMethod: "client_secret_basic",
          requirePkce: false,
          isActive: true,
        },
      });

    // Upsert the identity and bind it to the client.
    if (existing) {
      await tx
        .update(agentIdentities)
        .set({ scopes: agent.scopes, kind: agent.kind, roleId, oauthClientId: clientId, isActive: true })
        .where(eq(agentIdentities.id, existing.id));
    } else {
      await tx.insert(agentIdentities).values({
        name: agent.name,
        kind: agent.kind,
        roleId,
        scopes: agent.scopes,
        oauthClientId: clientId,
        isActive: true,
      });
    }
  }, "seedAtriumAgents.seed");

  console.log(`+ ${agent.name}: created client ${clientId}`);
  console.log(`    client_id:     ${clientId}`);
  console.log(`    client_secret: ${clientSecret}   <-- STORE NOW; not recoverable`);
}

/**
 * Warn if ATRIUM_SYSTEM_USER_ID (when set) points at an administrator. A
 * client-credentials token is stamped sub=this id, so an admin here means
 * autonomous agents could edit that account's content + pass admin gates on
 * non-content endpoints. It must be a dedicated non-admin service account.
 */
async function warnIfSystemUserIsAdmin(): Promise<void> {
  const id = Number.parseInt(process.env.ATRIUM_SYSTEM_USER_ID ?? "", 10);
  if (!Number.isInteger(id) || id <= 0) {
    console.warn(
      "⚠ ATRIUM_SYSTEM_USER_ID is not set — autonomous-agent content has no owner " +
        "until you set it (to a DEDICATED non-admin service account)."
    );
    return;
  }
  const rows = await executeQuery(
    (db) =>
      db
        .select({ id: roles.id })
        .from(userRoles)
        .innerJoin(roles, eq(userRoles.roleId, roles.id))
        .where(and(eq(userRoles.userId, id), eq(roles.name, "administrator")))
        .limit(1),
    "seedAtriumAgents.systemUserAdminCheck"
  );
  if (rows[0]) {
    console.error(
      `❌ SECURITY: ATRIUM_SYSTEM_USER_ID=${id} is an ADMINISTRATOR. Repoint it at a ` +
        "dedicated NON-ADMIN service account before using autonomous agents."
    );
  }
}

async function main(): Promise<void> {
  await warnIfSystemUserIsAdmin();
  const roleId = await staffRoleId();
  if (roleId == null) {
    console.warn("⚠ no 'staff' role found; seeding identities with null role (visibility = role-empty)");
  }
  for (const agent of SEED_AGENTS) {
    await seedAgent(agent, roleId);
  }
  console.log("\nDone. Bind these client_id/secret pairs to your agent runtimes and");
  console.log("ensure ATRIUM_SYSTEM_USER_ID is set so autonomous content has an owner.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("seed-atrium-agents failed:", err);
    process.exit(1);
  });
