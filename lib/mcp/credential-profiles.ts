/**
 * Server-owned connector credential profiles.
 *
 * Administrators select an opaque profile id; they never provide a Secrets
 * Manager id/ARN. Each profile is deployment-configured and bound to exact
 * provider origins.
 */

interface CredentialProfile {
  secretId: string;
  allowedOrigins: string[];
}

function configuredProfiles(): Record<string, CredentialProfile> {
  const raw = process.env.MCP_OAUTH_CREDENTIAL_PROFILES;
  if (!raw) return Object.create(null) as Record<string, CredentialProfile>;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MCP OAuth credential profiles are not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MCP OAuth credential profiles must be an object");
  }

  const profiles = Object.create(null) as Record<string, CredentialProfile>;
  for (const [id, value] of Object.entries(parsed)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (
      typeof record.secretId !== "string" ||
      !Array.isArray(record.allowedOrigins) ||
      !record.allowedOrigins.every((origin) => typeof origin === "string")
    ) {
      continue;
    }
    profiles[id] = {
      secretId: record.secretId,
      allowedOrigins: record.allowedOrigins.map((origin) => new URL(origin).origin),
    };
  }
  return profiles;
}

export function resolveCredentialProfile(
  profileId: string,
  connectorUrl: string
): CredentialProfile {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(profileId)) {
    throw new Error("Invalid connector credential profile id");
  }
  const profile = configuredProfiles()[profileId];
  if (!profile) {
    throw new Error("Connector credential profile is not configured");
  }
  const origin = new URL(connectorUrl).origin;
  if (!profile.allowedOrigins.includes(origin)) {
    throw new Error("Connector credential profile is not approved for this origin");
  }
  return profile;
}

export function assertCredentialProfileUpdate(
  current: { url: string; profileId: string | null },
  update: { url?: string; profileId?: string | null }
): void {
  const effectiveUrl = update.url ?? current.url;
  const effectiveProfileId =
    update.profileId === undefined ? current.profileId : update.profileId;
  if (effectiveProfileId) {
    resolveCredentialProfile(effectiveProfileId, effectiveUrl);
  }
}
