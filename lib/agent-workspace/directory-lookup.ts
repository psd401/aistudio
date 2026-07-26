/**
 * District directory identity resolution (#1239).
 *
 * Answers two questions against the Google People API DIRECTORY surface,
 * using the `directory.readonly` scope AGENT_DWD_SCOPES already carries — no
 * new scope, no admin role on the service account, and deliberately NOT
 * `contacts.readonly` (that grants personal contacts, a different thing):
 *
 *   email          -> who that is   (people.searchDirectoryPeople)
 *   Chat user id   -> who that is   (people.get on the same numeric id)
 *
 * The Chat `users/{id}` numeric id IS the People API person id, so the second
 * lookup is a direct get. Probed live 2026-07-26 with an `agnt_` DWD token:
 * people.get returns POPULATED fields in the service-account context, which is
 * why the Admin SDK fallback (Option B on #1239, needing a "Users > Read"
 * admin role on the SA) is not built.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RUNS SERVER-SIDE
 * ---------------------------------------------------------------------------
 * The first implementation of this lived in the agent container and minted a
 * Google token into the model runtime. #1353 removed exactly that capability:
 * the model runtime must never hold a reusable Google token, and the owner is
 * derived from a proxy-signed invocation context rather than asserted by the
 * model. So the lookup lives here, behind /api/agent/directory-lookup, and the
 * container only ever receives a shaped person record — never a token.
 *
 * ---------------------------------------------------------------------------
 * DELIBERATE NON-CAPABILITY: no enumeration
 * ---------------------------------------------------------------------------
 * TARGETED resolution only. `people.listDirectoryPeople` is never called and
 * there is no "list everyone" entry point. The district directory contains
 * ClassLink-provisioned STUDENT records (name, @edtools address, grade,
 * building), so a bulk-list capability reachable from the agent would be a
 * student-directory dumper one prompt away. Resolving an identity the agent
 * already encountered is a different act from enumerating children.
 */

const PEOPLE_BASE = "https://people.googleapis.com/v1"
const READ_MASK = "names,emailAddresses,organizations"

/**
 * Cache TTLs. Directory data is slow-moving (titles change on the order of
 * months). Negatives expire far sooner on purpose: a miss is usually a race
 * with account provisioning, and caching that for hours would make a new hire
 * look permanently unresolvable.
 */
export const POSITIVE_TTL_MS = 12 * 60 * 60 * 1000
export const NEGATIVE_TTL_MS = 5 * 60 * 1000

/** Bound the in-process cache so a long-lived task cannot grow it without limit. */
const MAX_CACHE_ENTRIES = 500

export interface DirectoryPerson {
  personId: string | null
  displayName: string | null
  email: string | null
  title: string | null
  department: string | null
  organization: string | null
}

export type DirectoryResult =
  | ({ found: true; cached?: boolean; matchedAlias?: string } & DirectoryPerson)
  | { found: false; cached?: boolean; query: string; reason: string }

export type DirectoryErrorCode =
  | "DIRECTORY_SHARING_DISABLED"
  | "INSUFFICIENT_SCOPE"
  | "FORBIDDEN"
  | "TRANSPORT"
  | "LOOKUP_FAILED"
  | "INVALID_INPUT"

export class DirectoryError extends Error {
  code: DirectoryErrorCode
  constructor(code: DirectoryErrorCode, message: string) {
    super(message)
    this.code = code
    this.name = "DirectoryError"
  }
}

interface CacheEntry {
  expiresAt: number
  value: DirectoryResult
}

const cache = new Map<string, CacheEntry>()

function readCache(key: string, now: number): DirectoryResult | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (entry.expiresAt <= now) {
    cache.delete(key)
    return null
  }
  return entry.value
}

function writeCache(key: string, value: DirectoryResult, now: number): void {
  const ttl = value.found ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS
  // Simple FIFO eviction — the oldest inserted key goes first. Directory
  // lookups are low-cardinality per task, so an LRU would add bookkeeping for
  // no measurable benefit.
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, { expiresAt: now + ttl, value })
}

/** Test seam — the cache is process-global, so tests must be able to reset it. */
export function __clearDirectoryCache(): void {
  cache.clear()
}

/**
 * Normalize a Chat person reference to a bare People API id.
 * Accepts `users/123`, `people/123` or `123`; returns null otherwise.
 *
 * The id is interpolated into the request path, so rejecting anything
 * non-numeric here is the input-validation boundary, not a cosmetic check.
 */
export function normalizePersonId(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim().replace(/^(users|people)\//i, "")
  return /^\d+$/.test(trimmed) ? trimmed : null
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim().toLowerCase()
  // Deliberately loose — Google is the authority on whether an address
  // exists. This only rejects input that cannot be an address at all.
  //
  // Parsed rather than regex-matched. The obvious pattern
  // /^[^@\s]+@[^@\s]+\.[^@\s]+$/ draws CodeQL js/polynomial-redos: `[^@\s]`
  // also matches `.`, so the domain half is genuinely ambiguous about which
  // dot is the separator.
  //
  // Honest caveat: I could NOT reproduce a practical slowdown. V8 evaluates
  // CodeQL's own witness string ("!@!." plus many "!." repetitions) in under
  // 0.1 ms at 20k repetitions, so this is a theoretical ambiguity rather than
  // a live DoS. The parse is kept anyway because it is clearer about what an
  // address must look like and removes the ambiguity outright — not because a
  // measured attack was fixed.
  //
  // One deliberate behaviour change, found by differential-testing the two
  // forms across a case table: the old regex ACCEPTED a trailing-dot domain
  // ("a@b.c.") purely because `[^@\s]` also matches `.`, so the final
  // `[^@\s]+$` happily consumed "c.". This rejects it. That is a narrowing,
  // and an intentional one — such an address resolves to nothing at Google
  // anyway, so failing here is a clearer answer than an empty directory miss.
  if (/\s/.test(trimmed)) return null
  const at = trimmed.indexOf("@")
  if (at <= 0 || at !== trimmed.lastIndexOf("@")) return null
  const domain = trimmed.slice(at + 1)
  // A domain needs a dot with at least one character on each side. Checking
  // only the FIRST dot's position is not enough — that accepts "b.c." — so
  // both ends are tested explicitly.
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) {
    return null
  }
  return trimmed
}

/**
 * Distinguish failures that demand different remedies.
 *
 *   DIRECTORY_SHARING_DISABLED — the Workspace admin console setting
 *     "External Directory Sharing" is restrictive. NO code change fixes it;
 *     it is an admin action. This was the real state of this district until
 *     2026-07-26, and it looks identical to a permissions bug unless named.
 *   INSUFFICIENT_SCOPE — the token genuinely lacks directory.readonly.
 *   TRANSPORT — upstream outage; the caller should retry.
 */
export function classifyError(
  status: number,
  body: unknown,
): { code: DirectoryErrorCode; message: string } {
  const message =
    (body as { error?: { message?: string } } | null)?.error?.message ?? ""
  if (status === 403 && /external directory sharing/i.test(message)) {
    return { code: "DIRECTORY_SHARING_DISABLED", message }
  }
  if (status === 403 && /insufficient authentication scopes/i.test(message)) {
    return { code: "INSUFFICIENT_SCOPE", message }
  }
  if (status === 403 || status === 401) {
    return { code: "FORBIDDEN", message }
  }
  // 5xx is an upstream outage, not a bad request, and must be retryable. A
  // load-balancer 502 also carries an HTML body, so `message` is empty and the
  // STATUS is the only signal — never classify on the parsed body.
  if (status >= 500) {
    return {
      code: "TRANSPORT",
      message: message || `People API returned HTTP ${status}`,
    }
  }
  return { code: "LOOKUP_FAILED", message: message || `HTTP ${status}` }
}

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
}>

async function callPeople(
  url: string,
  accessToken: string,
  fetchImpl?: FetchLike,
): Promise<unknown> {
  const doFetch = (fetchImpl ?? globalThis.fetch) as FetchLike
  let resp: Awaited<ReturnType<FetchLike>>
  try {
    resp = await doFetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  } catch (err) {
    throw new DirectoryError(
      "TRANSPORT",
      `People API request failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  // Status first, body second. On failure the body only enriches the message.
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}))
    const { code, message } = classifyError(resp.status, body)
    throw new DirectoryError(code, message)
  }
  // A 2xx whose body will not parse must NOT degrade to `{}` — that would
  // shape into found:false, reporting "not in the directory" for a person who
  // is in it, and caching that miss.
  try {
    return await resp.json()
  } catch (err) {
    throw new DirectoryError(
      "LOOKUP_FAILED",
      `People API returned an unparseable body: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

interface PeopleValue {
  value?: string
  metadata?: { primary?: boolean }
}
interface PeopleName {
  displayName?: string
  metadata?: { primary?: boolean }
}
interface PeopleOrg {
  title?: string
  department?: string
  name?: string
  metadata?: { primary?: boolean }
}
interface PeoplePerson {
  resourceName?: string
  names?: PeopleName[]
  emailAddresses?: PeopleValue[]
  organizations?: PeopleOrg[]
}

/** Every address on a record, lowercased — primary AND aliases. */
export function addressesOf(person: PeoplePerson | null | undefined): string[] {
  if (!person || !Array.isArray(person.emailAddresses)) return []
  return person.emailAddresses
    .map((e) => (typeof e?.value === "string" ? e.value.trim().toLowerCase() : null))
    .filter((v): v is string => Boolean(v))
}

function primaryOf<T extends { metadata?: { primary?: boolean } }>(
  list: T[] | undefined,
): T | null {
  if (!Array.isArray(list) || list.length === 0) return null
  return list.find((x) => x?.metadata?.primary) ?? list[0] ?? null
}

/**
 * Shape a People person into the flat record the agent wants. Returns null
 * when the payload carries no usable identity, so an empty response is
 * reported as "not found" rather than as a person with no name.
 */
function personIdOf(person: PeoplePerson): string | null {
  return typeof person.resourceName === "string"
    ? person.resourceName.replace(/^people\//, "")
    : null
}

function orgFieldsOf(
  org: PeopleOrg | null,
): Pick<DirectoryPerson, "title" | "department" | "organization"> {
  return {
    title: org?.title ?? null,
    department: org?.department ?? null,
    organization: org?.name ?? null,
  }
}

export function shapePerson(person: PeoplePerson | null | undefined): DirectoryPerson | null {
  if (!person || typeof person !== "object") return null
  const displayName = primaryOf(person.names)?.displayName ?? null
  const email = primaryOf(person.emailAddresses)?.value ?? null
  if (!displayName && !email) return null
  return {
    personId: personIdOf(person),
    displayName,
    email,
    ...orgFieldsOf(primaryOf(person.organizations)),
  }
}

export interface LookupOptions {
  /**
   * REQUIRED for caching. The trusted owner identity this lookup is being
   * performed as — from the proxy-signed invocation context, never the
   * request body.
   *
   * The cache is process-global (one Next.js instance serves every agent), so
   * an unpartitioned key would let owner B receive owner A's result without B's
   * token ever being used. Directory visibility is per-account, and this
   * directory contains STUDENT records, so that is a cross-account disclosure
   * — not merely a stale-data bug. It is also a regression risk created by
   * moving the cache server-side: the previous per-container cache was
   * partitioned by construction, because a container serves one owner.
   *
   * When absent, caching is skipped entirely rather than sharing a bucket.
   */
  ownerKey?: string
  now?: number
  noCache?: boolean
  fetchImpl?: FetchLike
}

/**
 * Namespace a cache key by owner. Returns null when there is no owner to
 * partition by, which callers treat as "do not cache" — failing closed rather
 * than falling back to a shared bucket.
 */
function cacheKeyFor(ownerKey: string | undefined, suffix: string): string | null {
  if (!ownerKey) return null
  return `${ownerKey.toLowerCase()}|${suffix}`
}

/**
 * email -> district person.
 *
 * Match is EXACT and considers every address on a record, not only the
 * primary. searchDirectoryPeople is a prefix/substring search, so one query
 * can return several people — reporting the first would make the agent
 * confidently name the WRONG human, which is worse than naming nobody. And
 * matching only the primary would miss aliases (a firstname.lastname form, or
 * a pre-name-change address), which are exactly the addresses a human is most
 * likely to supply.
 */
/**
 * Build the result for an email lookup. Split out of resolveEmail to keep that
 * function under the complexity ceiling, and because the alias-reporting rule
 * is worth reading on its own: when the query matched a NON-primary address we
 * say so, otherwise the answer looks like it is about a different person than
 * the one that was asked about.
 */
function emailResult(
  shaped: DirectoryPerson | null,
  normalized: string,
  candidateCount: number,
): DirectoryResult {
  if (!shaped) {
    return {
      found: false,
      query: normalized,
      reason: candidateCount > 0 ? "no exact address match" : "not in directory",
    }
  }
  const isAlias = Boolean(shaped.email) && shaped.email?.toLowerCase() !== normalized
  return { found: true, ...shaped, ...(isAlias ? { matchedAlias: normalized } : {}) }
}

export async function resolveEmail(
  email: string,
  accessToken: string,
  opts: LookupOptions = {},
): Promise<DirectoryResult> {
  const normalized = normalizeEmail(email)
  if (!normalized) {
    throw new DirectoryError("INVALID_INPUT", `Not a valid email address: ${email}`)
  }
  const now = opts.now ?? Date.now()
  const key = cacheKeyFor(opts.ownerKey, `email:${normalized}`)

  if (key && !opts.noCache) {
    const hit = readCache(key, now)
    if (hit) return { ...hit, cached: true }
  }

  const url =
    `${PEOPLE_BASE}/people:searchDirectoryPeople` +
    `?query=${encodeURIComponent(normalized)}` +
    `&readMask=${encodeURIComponent(READ_MASK)}` +
    `&sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE`
  const body = (await callPeople(url, accessToken, opts.fetchImpl)) as {
    people?: PeoplePerson[]
  }

  const candidates = Array.isArray(body.people) ? body.people : []
  const match = candidates.find((p) => addressesOf(p).includes(normalized)) ?? null
  const result = emailResult(match ? shapePerson(match) : null, normalized, candidates.length)
  if (key) writeCache(key, result, now)
  return result
}

/** Chat `users/{id}` -> district person, via people.get on the same id. */
export async function resolvePersonId(
  rawId: string,
  accessToken: string,
  opts: LookupOptions = {},
): Promise<DirectoryResult> {
  const id = normalizePersonId(rawId)
  if (!id) {
    throw new DirectoryError("INVALID_INPUT", `Not a valid person/Chat id: ${rawId}`)
  }
  const now = opts.now ?? Date.now()
  const key = cacheKeyFor(opts.ownerKey, `id:${id}`)

  if (key && !opts.noCache) {
    const hit = readCache(key, now)
    if (hit) return { ...hit, cached: true }
  }

  const url = `${PEOPLE_BASE}/people/${encodeURIComponent(id)}?personFields=${encodeURIComponent(READ_MASK)}`
  let body: unknown
  try {
    body = await callPeople(url, accessToken, opts.fetchImpl)
  } catch (err) {
    // A 404 is a legitimate "no such person", not a failure to report upward.
    if (
      err instanceof DirectoryError &&
      err.code === "LOOKUP_FAILED" &&
      /HTTP 404|not found/i.test(err.message)
    ) {
      const miss: DirectoryResult = {
        found: false,
        query: id,
        reason: "not in directory",
      }
      if (key) writeCache(key, miss, now)
      return miss
    }
    throw err
  }

  const shaped = shapePerson(body as PeoplePerson)
  const result: DirectoryResult = shaped
    ? { found: true, ...shaped }
    : {
        found: false,
        query: id,
        reason: "directory returned no usable fields",
      }
  if (key) writeCache(key, result, now)
  return result
}
