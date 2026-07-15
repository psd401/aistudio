/**
 * Consolidated GCP domain-wide-delegation (DWD) configuration (#1232/#1233).
 *
 * All the GCP identifiers the DWD token broker and the agnt_ provisioning-sheet
 * writer need live in ONE JSON secret rather than five plain CDK-context env
 * vars — aistudio is a PUBLIC repo, so the values must not land in cdk.json, and
 * Hagel does not want to re-pass `-c gcp…` flags on every deploy.
 *
 *   Secret id:  psd-agent/{env}/gcp-dwd-config   (override: GCP_DWD_CONFIG_SECRET_ID)
 *   Shape:      { projectNumber, wifPoolId, wifProviderId, serviceAccountEmail,
 *                 provisioningSheetId }
 *
 * Read lazily at request time (5-min cached by getSecretJson) so the ECS/Agent
 * task starts cleanly before IT (Reese) populates the secret — the broker /
 * provisioning fail CLOSED until then, exactly as they did with the empty env
 * defaults. Callers keep their own per-field env-var overrides for local dev and
 * unit tests (see loadBrokerConfig / getProvisioningSheetId), so a fully
 * env-configured process never touches Secrets Manager.
 */

import { getSecretJson } from "@/lib/agent-workspace/secrets-manager"

/** JSON shape of the psd-agent/{env}/gcp-dwd-config secret. All fields optional
 *  so a partially-populated secret still fails closed on the specific gap. */
export interface GcpDwdConfigSecret {
  projectNumber?: string
  wifPoolId?: string
  wifProviderId?: string
  serviceAccountEmail?: string
  provisioningSheetId?: string
}

/**
 * Secrets Manager id of the consolidated GCP DWD config. Overridable via
 * GCP_DWD_CONFIG_SECRET_ID; otherwise `psd-agent/{env}/gcp-dwd-config` where env
 * is ENVIRONMENT / DEPLOY_ENVIRONMENT / "dev".
 */
export function gcpDwdConfigSecretId(): string {
  const override = process.env.GCP_DWD_CONFIG_SECRET_ID?.trim()
  if (override) return override
  const environment = process.env.ENVIRONMENT ?? process.env.DEPLOY_ENVIRONMENT ?? "dev"
  return `psd-agent/${environment}/gcp-dwd-config`
}

/**
 * Fetch + JSON-parse the gcp-dwd-config secret (5-min cached via getSecretJson).
 * Returns null when the secret is absent or not valid JSON — callers treat that
 * as "not configured" and fail closed.
 */
export function loadGcpDwdConfigSecret(): Promise<GcpDwdConfigSecret | null> {
  return getSecretJson<GcpDwdConfigSecret>(gcpDwdConfigSecretId())
}

/**
 * First trimmed non-empty value from the arguments, or "" if none. Used to layer
 * env-var overrides over the secret's fields without inflating the caller's
 * cyclomatic complexity with `||`/`??`/`?.` chains.
 */
export function firstNonEmpty(...values: Array<string | undefined | null>): string {
  for (const v of values) {
    const trimmed = v?.trim()
    if (trimmed) return trimmed
  }
  return ""
}
