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

export function getProvisioningSheetId(): string {
  const id = process.env.AGENT_PROVISIONING_SHEET_ID?.trim() ?? ""
  if (!id) {
    throw new ProvisioningNotConfiguredError(
      "AGENT_PROVISIONING_SHEET_ID is not set — cannot request agnt_ account provisioning."
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
  /** Append `username` as a new row at the bottom of column A. */
  appendUsername(username: string): Promise<void>
}

/**
 * Ensure exactly one row for `username` exists in the sheet. Returns whether a
 * new row was written (false = a prior request already queued it). Safe under
 * two simultaneous requests for DIFFERENT users because append inserts a new
 * row rather than targeting a computed index.
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
 * append uses values.append on range `<tab>!A:A` with INSERT_ROWS. Column A is
 * plain data (the formulas live in other columns), so append targets the bottom
 * of that column. NOTE: verify append's table detection against the real sheet
 * once it exists (adjacent formula columns can occasionally confuse append); if
 * it misbehaves, switch to read-A -> update first-empty-cell -> read-back-verify.
 */
export function createSheetsGateway(deps: SheetsGatewayDeps = {}): SheetsGateway {
  const fetchImpl = deps.fetchImpl ?? fetch
  const getToken =
    deps.getAccessToken ??
    (async () => getImpersonatedAccessToken(loadBrokerConfig(), [SPREADSHEETS_SCOPE]))
  const sheetId = getProvisioningSheetId()
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}`
  const range = `${PROVISIONING_SHEET_TAB}!A:A`

  return {
    async readColumnA(): Promise<string[]> {
      const token = await getToken()
      const res = await fetchImpl(`${base}/values/${encodeURIComponent(range)}`, {
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
      const token = await getToken()
      const url =
        `${base}/values/${encodeURIComponent(range)}:append` +
        `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`
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
