/**
 * psd-directory — resolve a district identity instead of guessing (#1239).
 *
 * Two questions this answers, both against the Google People API's DIRECTORY
 * surface using the `directory.readonly` scope that AGENT_DWD_SCOPES already
 * carries (no new scope, no admin role, no `contacts.readonly`):
 *
 *   email        -> who that is    (people.searchDirectoryPeople)
 *   Chat user id -> who that is    (people.get on the same numeric id)
 *
 * The Chat `users/{id}` numeric id IS the People API person id, so the second
 * lookup is a direct get rather than a search. Probed live on 2026-07-26 with
 * an `agnt_` DWD token: people.get returns POPULATED names/emailAddresses in
 * the service-account context, which is why the Admin SDK fallback (Option B
 * on #1239, requiring a "Users > Read" admin role on the service account) is
 * NOT built.
 *
 * ---------------------------------------------------------------------------
 * DELIBERATE NON-CAPABILITY: no enumeration.
 * ---------------------------------------------------------------------------
 * This module exposes TARGETED resolution only. It never calls
 * people.listDirectoryPeople, and there is no "list everyone" entry point.
 * That is a safety property, not an oversight: the district directory
 * includes ClassLink-provisioned STUDENT records (name, @edtools address,
 * grade, building), so a bulk-list helper in the agent image would be a
 * student-directory dumper one prompt away. Resolving an identity the agent
 * has already encountered is a different act from enumerating children.
 * Keep it that way — see SKILL.md.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PEOPLE_BASE = 'https://people.googleapis.com/v1';
const READ_MASK = 'names,emailAddresses,organizations';

/**
 * Cache TTLs. Directory data is slow-moving (titles change on the order of
 * months), and the container is ephemeral, so a generous positive TTL is
 * safe and is the whole point of the acceptance criterion "lookups cached to
 * avoid per-message directory calls".
 *
 * Negatives get a SHORT ttl on purpose: a miss is often a race with
 * provisioning (a new hire, a freshly created agnt_ account), and caching
 * that for hours would make a real person look permanently unresolvable.
 */
const POSITIVE_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const NEGATIVE_TTL_MS = 5 * 60 * 1000; //  5m

/** Cache lives in the container's tmp; ephemeral by construction. */
function cacheDir() {
  return process.env.PSD_DIRECTORY_CACHE_DIR || path.join(os.tmpdir(), 'psd-directory-cache');
}

/**
 * Cache key -> filename. The key is hashed rather than used verbatim so an
 * address like `a/b@x` cannot escape the cache directory via path traversal,
 * and so no email address is written into a filename in plaintext.
 */
function cacheFile(key) {
  const hash = require('node:crypto').createHash('sha256').update(key).digest('hex').slice(0, 32);
  return path.join(cacheDir(), `${hash}.json`);
}

function readCache(key, now) {
  let raw;
  try {
    raw = fs.readFileSync(cacheFile(key), 'utf8');
  } catch {
    return null; // absent or unreadable — treat as a miss
  }
  let entry;
  try {
    entry = JSON.parse(raw);
  } catch {
    return null; // corrupt — treat as a miss rather than throwing
  }
  if (!entry || typeof entry.expiresAt !== 'number') return null;
  if (entry.expiresAt <= now) return null;
  return entry.value ?? null;
}

function writeCache(key, value, now) {
  const ttl = value && value.found ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
  const entry = { expiresAt: now + ttl, value };
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    // Write-then-rename so a concurrent reader never sees a half-written file.
    const tmp = `${cacheFile(key)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
    fs.renameSync(tmp, cacheFile(key));
  } catch {
    // A cache that cannot be written must never fail the lookup. The call
    // already succeeded; losing the cache costs latency, not correctness.
  }
}

/**
 * Normalize a Chat person reference to a bare People API id.
 * Accepts `users/123`, `people/123`, or a bare `123`.
 * Returns null if it is not a plausible id (digits only).
 */
function normalizePersonId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^(users|people)\//i, '');
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  // Deliberately loose: Google is the authority on whether an address exists.
  // This only rejects input that cannot be an address at all.
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Distinguish the two 403s that mean very different things, so the agent (and
 * whoever reads the logs) is not left guessing.
 *
 *   DIRECTORY_SHARING_DISABLED — the Workspace admin console setting
 *     "External Directory Sharing" is on its restrictive default. NO code
 *     change fixes this; it is an admin action. This was the actual state
 *     until 2026-07-26.
 *   INSUFFICIENT_SCOPE — the token genuinely lacks directory.readonly.
 */
function classifyError(status, body) {
  const message = (body && body.error && body.error.message) || '';
  if (status === 403 && /external directory sharing/i.test(message)) {
    return { code: 'DIRECTORY_SHARING_DISABLED', message };
  }
  if (status === 403 && /insufficient authentication scopes/i.test(message)) {
    return { code: 'INSUFFICIENT_SCOPE', message };
  }
  if (status === 403 || status === 401) {
    return { code: 'FORBIDDEN', message };
  }
  return { code: 'LOOKUP_FAILED', message: message || `HTTP ${status}` };
}

class DirectoryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function callPeople(url, accessToken, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  let resp;
  try {
    resp = await doFetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch (err) {
    throw new DirectoryError('TRANSPORT', `People API request failed: ${err.message}`);
  }
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const { code, message } = classifyError(resp.status, body);
    throw new DirectoryError(code, message);
  }
  return body;
}

/**
 * Every address on a directory record, lowercased — primary AND aliases.
 * Matching uses this; the shaped record still reports the primary as the
 * canonical `email`.
 */
function addressesOf(person) {
  if (!person || !Array.isArray(person.emailAddresses)) return [];
  return person.emailAddresses
    .map((e) => (e && typeof e.value === 'string' ? e.value.trim().toLowerCase() : null))
    .filter(Boolean);
}

/**
 * Shape a People API person into the flat record the agent actually wants.
 * Returns null when the payload carries no usable identity, so an empty
 * response is reported as "not found" rather than as a person with no name.
 */
function shapePerson(person) {
  if (!person || typeof person !== 'object') return null;
  const names = Array.isArray(person.names) ? person.names : [];
  const emails = Array.isArray(person.emailAddresses) ? person.emailAddresses : [];
  const orgs = Array.isArray(person.organizations) ? person.organizations : [];
  const primary = (list) => list.find((x) => x && x.metadata && x.metadata.primary) || list[0] || null;

  const name = primary(names);
  const email = primary(emails);
  const org = primary(orgs);
  const displayName = (name && name.displayName) || null;
  const emailAddress = (email && email.value) || null;
  if (!displayName && !emailAddress) return null;

  return {
    personId: typeof person.resourceName === 'string' ? person.resourceName.replace(/^people\//, '') : null,
    displayName,
    email: emailAddress,
    title: (org && org.title) || null,
    department: (org && org.department) || null,
    organization: (org && org.name) || null,
  };
}

/**
 * email -> district person. Uses searchDirectoryPeople because an address is
 * not a person id; the search is then confirmed against the returned address
 * so a fuzzy prefix match cannot silently resolve to the WRONG person — which
 * would be worse than not resolving at all, given the agent uses this to
 * decide who it is talking about.
 */
async function resolveEmail(email, accessToken, opts = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) throw new DirectoryError('INVALID_INPUT', `Not a valid email address: ${email}`);
  const now = opts.now || Date.now();
  const key = `email:${normalized}`;

  if (!opts.noCache) {
    const hit = readCache(key, now);
    if (hit) return { ...hit, cached: true };
  }

  const url =
    `${PEOPLE_BASE}/people:searchDirectoryPeople` +
    `?query=${encodeURIComponent(normalized)}` +
    `&readMask=${encodeURIComponent(READ_MASK)}` +
    `&sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE`;
  const body = await callPeople(url, accessToken, opts.fetchImpl);

  const candidates = Array.isArray(body.people) ? body.people : [];
  // Exact-address match only. searchDirectoryPeople is a prefix/substring
  // search, so "kris@" can return several people; picking [0] would be a
  // confident wrong answer.
  //
  // Match against EVERY address on the record, not just the primary. A
  // directory profile can carry aliases (a firstname.lastname form, or a
  // pre-name-change address kept as an alias), and those are exactly the
  // addresses a human is most likely to hand the agent. Comparing only the
  // primary — which is what shapePerson leaves behind — would report
  // found:false for a person Google had already returned correctly, then
  // cache that miss.
  const match = candidates.find((p) => addressesOf(p).includes(normalized)) || null;
  const shaped = match ? shapePerson(match) : null;

  // When the query matched an alias, say so rather than silently answering
  // about a different-looking address than the one that was asked about.
  const matchedAlias = shaped && shaped.email && shaped.email.toLowerCase() !== normalized ? normalized : null;

  const result = shaped
    ? { found: true, ...shaped, ...(matchedAlias ? { matchedAlias } : {}) }
    : { found: false, query: normalized, reason: candidates.length ? 'no exact address match' : 'not in directory' };
  writeCache(key, result, now);
  return result;
}

/**
 * Chat `users/{id}` -> district person, via people.get on the same id.
 */
async function resolvePersonId(rawId, accessToken, opts = {}) {
  const id = normalizePersonId(rawId);
  if (!id) throw new DirectoryError('INVALID_INPUT', `Not a valid person/Chat id: ${rawId}`);
  const now = opts.now || Date.now();
  const key = `id:${id}`;

  if (!opts.noCache) {
    const hit = readCache(key, now);
    if (hit) return { ...hit, cached: true };
  }

  const url = `${PEOPLE_BASE}/people/${encodeURIComponent(id)}?personFields=${encodeURIComponent(READ_MASK)}`;
  let body;
  try {
    body = await callPeople(url, accessToken, opts.fetchImpl);
  } catch (err) {
    // A 404 is a legitimate "no such person", not a failure to report upward.
    if (err instanceof DirectoryError && err.code === 'LOOKUP_FAILED' && /HTTP 404|not found/i.test(err.message)) {
      const miss = { found: false, query: id, reason: 'not in directory' };
      writeCache(key, miss, now);
      return miss;
    }
    throw err;
  }

  const shaped = shapePerson(body);
  const result = shaped
    ? { found: true, ...shaped }
    : { found: false, query: id, reason: 'directory returned no usable fields' };
  writeCache(key, result, now);
  return result;
}

module.exports = {
  resolveEmail,
  addressesOf,
  resolvePersonId,
  shapePerson,
  normalizeEmail,
  normalizePersonId,
  classifyError,
  readCache,
  writeCache,
  cacheDir,
  DirectoryError,
  POSITIVE_TTL_MS,
  NEGATIVE_TTL_MS,
};
