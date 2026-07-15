/**
 * agnt_ account provisioning via the OneSync sheet (#1233).
 *
 * IT provisions Workspace accounts from a Google Sheet fed to ClassLink OneSync
 * on a ~10–30 min schedule. To request an account we write the bare username
 * (e.g. `pratzm`) into the first empty row of column A of the `agents` tab. That
 * is the entire contract — other columns are sheet formulas that populate
 * themselves. OneSync creates the account on its next sync.
 *
 * The app writes AS the service account itself (plain file-sharing Editor
 * access), NOT via domain-wide delegation — so this uses the same WIF-
 * impersonated SA token as the broker, scoped to `spreadsheets`.
 *
 * The write is idempotent: a dedupe read of column A means repeated requests
 * for the same user never add a second row, and OneSync only ever needs one.
 */

import { createLogger, sanitizeForLogging } from "@/lib/logger"
import { loadBrokerConfig } from "@/lib/agent-workspace/dwd-token-broker"
import { getImpersonatedAccessToken } from "@/lib/agent-workspace/gcp-wif"
import { loadGcpDwdConfigSecret } from "@/lib/agent-workspace/gcp-dwd-config"

const log = createLogger({ module: "agent-provisioning-sheet" })

/** The tab and column the username goes in (per IT's OneSync sheet contract). */
export const PROVISIONING_SHEET_TAB = "agents"
const SPREADSHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets"

export class ProvisioningNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProvisioningNotConfiguredError"
  }
}

/**
 * Resolve the OneSync provisioning sheet id. Env-var override
 * (AGENT_PROVISIONING_SHEET_ID) first for local dev/tests, then the
 * `provisioningSheetId` field of the consolidated psd-agent/{env}/gcp-dwd-config
 * secret (5-min cached). Throws ProvisioningNotConfiguredError when neither is
 * set so provisioning fails closed.
 */
export async function getProvisioningSheetId(): Promise<string> {
  const envId = process.env.AGENT_PROVISIONING_SHEET_ID?.trim()
  if (envId) return envId

  const secret = await loadGcpDwdConfigSecret()
  const id = secret?.provisioningSheetId?.trim() ?? ""
  if (!id) {
    throw new ProvisioningNotConfiguredError(
      "Provisioning sheet id is not set (AGENT_PROVISIONING_SHEET_ID env or " +
        "provisioningSheetId in the psd-agent/{env}/gcp-dwd-config secret) — " +
        "cannot request agnt_ account provisioning."
    )
  }
  return id
}

/**
 * Is `username` already in column A (case-insensitive, trimmed)? The dedupe
 * gate that makes provisioning idempotent. Header cells / blanks are ignored.
 */
export function usernameAlreadyPresent(columnA: readonly string[], username: string): boolean {
  const target = username.trim().toLowerCase()
  if (!target) return false
  return columnA.some((v) => (v ?? "").trim().toLowerCase() === target)
}

/** Minimal Sheets surface — injectable so the dedupe/append logic is unit-testable. */
export interface SheetsGateway {
  /** Read the values in column A of the agents tab (top-to-bottom, incl. header). */
  readColumnA(): Promise<string[]>
  /** Fill `username` into the first empty cell of column A (no row inserted). */
  appendUsername(username: string): Promise<void>
}

/**
 * Ensure exactly one row for `username` exists in the sheet. Returns whether the
 * cell was written (false = a prior request already queued it). Safe under two
 * simultaneous requests for DIFFERENT users: append resolves the target cell
 * server-side atomically, so concurrent writes land in distinct rows — it fills
 * the first empty column-A cell rather than inserting a row (#1237).
 */
export async function ensureAgentUsernameRow(
  username: string,
  gateway: SheetsGateway
): Promise<{ written: boolean }> {
  const existing = await gateway.readColumnA()
  if (usernameAlreadyPresent(existing, username)) {
    return { written: false }
  }
  await gateway.appendUsername(username)
  return { written: true }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ""
  }
}

/** Test seam for the real gateway's dependencies. */
export interface SheetsGatewayDeps {
  fetchImpl?: typeof fetch
  getAccessToken?: () => Promise<string>
}

/**
 * The production Sheets gateway. Reads/writes column A of the agents tab via the
 * Sheets REST API using a spreadsheets-scoped, WIF-impersonated SA token.
 *
 * append uses values.append on range `<tab>!A:A` with insertDataOption=OVERWRITE.
 * The `agents` tab has pre-formatted rows (formulas dragged down in columns B+;
 * column A blank until used), so append's table detection lands on the first
 * empty column-A cell and OVERWRITE FILLS it. INSERT_ROWS was wrong — it inserted
 * a fresh, formula-less row, so OneSync saw a username with every other column
 * blank (#1237). Only column A is written, so the B+ formulas are untouched.
 */
export function createSheetsGateway(deps: SheetsGatewayDeps = {}): SheetsGateway {
  const fetchImpl = deps.fetchImpl ?? fetch
  const getToken =
    deps.getAccessToken ??
    (async () => getImpersonatedAccessToken(await loadBrokerConfig(), [SPREADSHEETS_SCOPE]))
  const range = `${PROVISIONING_SHEET_TAB}!A:A`

  // The sheet id is read lazily (getProvisioningSheetId is async — env override
  // or the gcp-dwd-config secret), so construction stays synchronous. Memoized
  // for the second call within one gateway instance.
  let _base: string | null = null
  const base = async (): Promise<string> => {
    if (_base) return _base
    const sheetId = await getProvisioningSheetId()
    _base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}`
    return _base
  }

  return {
    async readColumnA(): Promise<string[]> {
      const [token, baseUrl] = await Promise.all([getToken(), base()])
      const res = await fetchImpl(`${baseUrl}/values/${encodeURIComponent(range)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) {
        throw new Error(`Sheets values.get failed (HTTP ${res.status}): ${(await safeText(res)).slice(0, 300)}`)
      }
      const body = (await res.json()) as { values?: string[][] }
      // Column-A read → one value per row; flatten and drop empties.
      return (body.values ?? []).map((row) => (row?.[0] ?? "")).filter((v) => v !== "")
    },

    async appendUsername(username: string): Promise<void> {
      const [token, baseUrl] = await Promise.all([getToken(), base()])
      const url =
        `${baseUrl}/values/${encodeURIComponent(range)}:append` +
        `?valueInputOption=RAW&insertDataOption=OVERWRITE`
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ range, majorDimension: "ROWS", values: [[username]] }),
      })
      if (!res.ok) {
        throw new Error(`Sheets values.append failed (HTTP ${res.status}): ${(await safeText(res)).slice(0, 300)}`)
      }
      log.info("Appended username to provisioning sheet", sanitizeForLogging({ username }))
    },
  }
}
