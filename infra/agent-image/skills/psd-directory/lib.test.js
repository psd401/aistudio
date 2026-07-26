/**
 * psd-directory lib tests (#1239).
 *
 * Run: bun test lib.test.js   (from this directory, or via
 *      `bun run test:skill:directory` at the repo root)
 *
 * These pin the properties that would silently produce a WRONG identity
 * rather than a visible failure — which is the whole point of the issue, since
 * the agent uses these answers to decide who it is talking about.
 */

'use strict';

const { test, expect, describe, beforeEach, afterEach } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lib = require('./lib');

// Isolate the on-disk cache per run so tests never read each other's writes
// (or the developer's real cache).
let CACHE_DIR;
beforeEach(() => {
  CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'psd-dir-test-'));
  process.env.PSD_DIRECTORY_CACHE_DIR = CACHE_DIR;
});
afterEach(() => {
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  delete process.env.PSD_DIRECTORY_CACHE_DIR;
});

/** Build a People API person payload. */
const person = (id, name, email, org) => ({
  resourceName: `people/${id}`,
  names: name ? [{ metadata: { primary: true }, displayName: name }] : [],
  emailAddresses: email ? [{ metadata: { primary: true }, value: email }] : [],
  organizations: org ? [{ metadata: { primary: true }, ...org }] : [],
});

/** A fetch stub that records calls and returns a canned response. */
function stubFetch(responder) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const { status = 200, body = {} } = responder(url) || {};
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

describe('normalizePersonId', () => {
  test('accepts users/, people/ and bare numeric forms', () => {
    expect(lib.normalizePersonId('users/12345')).toBe('12345');
    expect(lib.normalizePersonId('people/12345')).toBe('12345');
    expect(lib.normalizePersonId('12345')).toBe('12345');
    expect(lib.normalizePersonId('  users/12345  ')).toBe('12345');
  });

  test('rejects anything that is not a bare id', () => {
    // A non-numeric id would be interpolated into the request path, so this
    // is the input-validation boundary, not a cosmetic check.
    expect(lib.normalizePersonId('users/../../etc/passwd')).toBeNull();
    expect(lib.normalizePersonId('me')).toBeNull();
    expect(lib.normalizePersonId('')).toBeNull();
    expect(lib.normalizePersonId(null)).toBeNull();
  });
});

describe('resolveEmail', () => {
  test('returns the person on an exact address match', async () => {
    const fetchImpl = stubFetch(() => ({
      body: {
        people: [
          person('116', 'Kris Hagel', 'hagelk@psd401.net', {
            title: 'Chief',
            department: 'Multiple Locations',
            name: 'Peninsula School District',
          }),
        ],
      },
    }));
    const r = await lib.resolveEmail('hagelk@psd401.net', 'tok', { fetchImpl });
    expect(r.found).toBe(true);
    expect(r.displayName).toBe('Kris Hagel');
    expect(r.personId).toBe('116');
    expect(r.title).toBe('Chief');
    expect(r.department).toBe('Multiple Locations');
  });

  test('a near-miss search result is NOT reported as the person', async () => {
    // searchDirectoryPeople is a prefix/substring search: querying one address
    // can return other people. Taking [0] would be a confident WRONG answer —
    // the agent would attribute a message to the wrong human. Exact-address
    // match is the only acceptable rule.
    const fetchImpl = stubFetch(() => ({
      body: {
        people: [
          person('1', 'Kristen Hagelin', 'hagelink@psd401.net', null),
          person('2', 'Kris Hagelund', 'hagelund@psd401.net', null),
        ],
      },
    }));
    const r = await lib.resolveEmail('hagel@psd401.net', 'tok', { fetchImpl });
    expect(r.found).toBe(false);
    expect(r.reason).toBe('no exact address match');
  });

  test('an ALIAS address resolves to the person (codex P2)', async () => {
    // A directory profile can carry aliases — a firstname.lastname form, or a
    // pre-name-change address kept as an alias — and those are exactly the
    // addresses a human is most likely to hand the agent. Matching only the
    // PRIMARY address would report found:false for a person Google had
    // already returned correctly, and then cache that miss.
    const rec = person('116', 'Kris Hagel', 'hagelk@psd401.net', null);
    rec.emailAddresses.push({ metadata: { primary: false }, value: 'kris.hagel@psd401.net' });
    const fetchImpl = stubFetch(() => ({ body: { people: [rec] } }));

    const r = await lib.resolveEmail('kris.hagel@psd401.net', 'tok', { fetchImpl });
    expect(r.found).toBe(true);
    expect(r.personId).toBe('116');
    // The canonical address is still reported as `email`...
    expect(r.email).toBe('hagelk@psd401.net');
    // ...and the alias that was actually asked about is surfaced, so the
    // answer cannot look like it is about a different person.
    expect(r.matchedAlias).toBe('kris.hagel@psd401.net');
  });

  test('matchedAlias is absent when the primary address was the query', async () => {
    const fetchImpl = stubFetch(() => ({
      body: { people: [person('116', 'Kris Hagel', 'hagelk@psd401.net', null)] },
    }));
    const r = await lib.resolveEmail('hagelk@psd401.net', 'tok', { fetchImpl });
    expect(r.found).toBe(true);
    expect(r.matchedAlias).toBeUndefined();
  });

  test('an alias on the WRONG record still does not match', async () => {
    // Widening the comparison to every address must not weaken the
    // exact-match rule that stops a fuzzy hit being reported as the person.
    const other = person('2', 'Someone Else', 'else@psd401.net', null);
    other.emailAddresses.push({ metadata: { primary: false }, value: 'se@psd401.net' });
    const fetchImpl = stubFetch(() => ({ body: { people: [other] } }));
    const r = await lib.resolveEmail('hagel@psd401.net', 'tok', { fetchImpl });
    expect(r.found).toBe(false);
    expect(r.reason).toBe('no exact address match');
  });

  test('matches case-insensitively', async () => {
    const fetchImpl = stubFetch(() => ({
      body: { people: [person('116', 'Kris Hagel', 'HagelK@psd401.net', null)] },
    }));
    const r = await lib.resolveEmail('HAGELK@PSD401.NET', 'tok', { fetchImpl });
    expect(r.found).toBe(true);
    expect(r.personId).toBe('116');
  });

  test('rejects input that cannot be an address', async () => {
    await expect(lib.resolveEmail('not-an-address', 'tok', {})).rejects.toThrow(/valid email/i);
  });

  test('requests only the DOMAIN_PROFILE source', async () => {
    const fetchImpl = stubFetch(() => ({ body: { people: [] } }));
    await lib.resolveEmail('x@psd401.net', 'tok', { fetchImpl });
    expect(fetchImpl.calls[0]).toContain('sources=DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE');
    // The colon in the RPC-style verb is not percent-encoded in the request.
    expect(fetchImpl.calls[0]).toContain('/people:searchDirectoryPeople');
  });
});

describe('resolvePersonId', () => {
  test('resolves a Chat users/{id} via people.get', async () => {
    const fetchImpl = stubFetch(() => ({
      body: person('116264913639920976203', 'Kris Hagel', 'hagelk@psd401.net', { title: 'Chief' }),
    }));
    const r = await lib.resolvePersonId('users/116264913639920976203', 'tok', { fetchImpl });
    expect(r.found).toBe(true);
    expect(r.displayName).toBe('Kris Hagel');
    expect(r.email).toBe('hagelk@psd401.net');
    expect(fetchImpl.calls[0]).toContain('/people/116264913639920976203');
  });

  test('an empty-field response is a MISS, not a nameless person', async () => {
    // This is the exact failure mode #1239 feared for the service-account
    // context (and the trigger for Option B). If it ever starts happening, the
    // agent must see found:false rather than a person with null everything.
    const fetchImpl = stubFetch(() => ({ body: { resourceName: 'people/999' } }));
    const r = await lib.resolvePersonId('users/999', 'tok', { fetchImpl });
    expect(r.found).toBe(false);
    expect(r.reason).toBe('directory returned no usable fields');
  });

  test('a 404 is a miss, not an error', async () => {
    const fetchImpl = stubFetch(() => ({ status: 404, body: { error: { message: 'Requested entity was not found.' } } }));
    const r = await lib.resolvePersonId('users/404', 'tok', { fetchImpl });
    expect(r.found).toBe(false);
    expect(r.reason).toBe('not in directory');
  });
});

describe('error classification', () => {
  test('the admin-console 403 is distinguished from a scope 403', () => {
    // These two 403s demand completely different remedies — an admin action
    // vs a token/scope fix. Collapsing them is what made #1239 expensive to
    // diagnose, so the distinction is pinned.
    expect(
      lib.classifyError(403, { error: { message: 'The G Suite domain admin has disabled external directory sharing.' } }).code
    ).toBe('DIRECTORY_SHARING_DISABLED');
    expect(
      lib.classifyError(403, { error: { message: 'Request had insufficient authentication scopes.' } }).code
    ).toBe('INSUFFICIENT_SCOPE');
  });

  test('the sharing-disabled 403 propagates as a typed error', async () => {
    const fetchImpl = stubFetch(() => ({
      status: 403,
      body: { error: { message: 'The G Suite domain admin has disabled external directory sharing.' } },
    }));
    await expect(lib.resolveEmail('x@psd401.net', 'tok', { fetchImpl })).rejects.toMatchObject({
      code: 'DIRECTORY_SHARING_DISABLED',
    });
  });
});

describe('caching', () => {
  test('a second lookup does not call the API', async () => {
    const fetchImpl = stubFetch(() => ({
      body: { people: [person('116', 'Kris Hagel', 'hagelk@psd401.net', null)] },
    }));
    const first = await lib.resolveEmail('hagelk@psd401.net', 'tok', { fetchImpl });
    const second = await lib.resolveEmail('hagelk@psd401.net', 'tok', { fetchImpl });
    expect(first.cached).toBeUndefined();
    expect(second.cached).toBe(true);
    expect(second.displayName).toBe('Kris Hagel');
    // The acceptance criterion is "cached to avoid per-message directory
    // calls" — so the call count, not just the returned value, is the assertion.
    expect(fetchImpl.calls.length).toBe(1);
  });

  test('--no-cache forces a fresh call', async () => {
    const fetchImpl = stubFetch(() => ({
      body: { people: [person('116', 'Kris Hagel', 'hagelk@psd401.net', null)] },
    }));
    await lib.resolveEmail('hagelk@psd401.net', 'tok', { fetchImpl });
    await lib.resolveEmail('hagelk@psd401.net', 'tok', { fetchImpl, noCache: true });
    expect(fetchImpl.calls.length).toBe(2);
  });

  test('an expired positive entry is refetched', async () => {
    const fetchImpl = stubFetch(() => ({
      body: { people: [person('116', 'Kris Hagel', 'hagelk@psd401.net', null)] },
    }));
    const t0 = 1_000_000;
    await lib.resolveEmail('hagelk@psd401.net', 'tok', { fetchImpl, now: t0 });
    await lib.resolveEmail('hagelk@psd401.net', 'tok', {
      fetchImpl,
      now: t0 + lib.POSITIVE_TTL_MS + 1,
    });
    expect(fetchImpl.calls.length).toBe(2);
  });

  test('misses expire much faster than hits', async () => {
    // A miss is often a race with provisioning; caching it for the positive
    // TTL would make a real new hire look permanently unresolvable.
    expect(lib.NEGATIVE_TTL_MS).toBeLessThan(lib.POSITIVE_TTL_MS);

    const fetchImpl = stubFetch(() => ({ body: { people: [] } }));
    const t0 = 2_000_000;
    await lib.resolveEmail('ghost@psd401.net', 'tok', { fetchImpl, now: t0 });
    await lib.resolveEmail('ghost@psd401.net', 'tok', { fetchImpl, now: t0 + lib.NEGATIVE_TTL_MS + 1 });
    expect(fetchImpl.calls.length).toBe(2);
  });

  test('email and id lookups do not collide in the cache', async () => {
    const fetchEmail = stubFetch(() => ({
      body: { people: [person('116', 'Kris Hagel', 'hagelk@psd401.net', null)] },
    }));
    const fetchId = stubFetch(() => ({ body: person('999', 'Someone Else', 'else@psd401.net', null) }));
    await lib.resolveEmail('hagelk@psd401.net', 'tok', { fetchImpl: fetchEmail });
    const byId = await lib.resolvePersonId('users/999', 'tok', { fetchImpl: fetchId });
    expect(byId.displayName).toBe('Someone Else');
    expect(fetchId.calls.length).toBe(1);
  });

  test('a corrupt cache file is a miss, not a crash', async () => {
    const fetchImpl = stubFetch(() => ({
      body: { people: [person('116', 'Kris Hagel', 'hagelk@psd401.net', null)] },
    }));
    await lib.resolveEmail('hagelk@psd401.net', 'tok', { fetchImpl });
    for (const f of fs.readdirSync(CACHE_DIR)) {
      fs.writeFileSync(path.join(CACHE_DIR, f), '{not json');
    }
    const r = await lib.resolveEmail('hagelk@psd401.net', 'tok', { fetchImpl });
    expect(r.found).toBe(true);
    expect(fetchImpl.calls.length).toBe(2);
  });

  test('an unwritable cache directory does not fail the lookup', async () => {
    // Losing the cache costs latency, not correctness — the lookup already
    // succeeded by the time we try to persist it.
    process.env.PSD_DIRECTORY_CACHE_DIR = '/proc/psd-directory-cannot-exist';
    const fetchImpl = stubFetch(() => ({
      body: { people: [person('116', 'Kris Hagel', 'hagelk@psd401.net', null)] },
    }));
    const r = await lib.resolveEmail('hagelk@psd401.net', 'tok', { fetchImpl });
    expect(r.found).toBe(true);
  });

  test('no email address is written into a cache filename in plaintext', async () => {
    const fetchImpl = stubFetch(() => ({
      body: { people: [person('116', 'Kris Hagel', 'hagelk@psd401.net', null)] },
    }));
    await lib.resolveEmail('hagelk@psd401.net', 'tok', { fetchImpl });
    for (const f of fs.readdirSync(CACHE_DIR)) {
      expect(f).not.toContain('hagelk');
      expect(f).not.toContain('@');
    }
  });
});

describe('no enumeration surface', () => {
  test('the module exposes no directory-listing entry point', () => {
    // The district directory contains ClassLink-provisioned STUDENT records.
    // A list/enumerate helper here would be a student-directory dumper one
    // prompt away, so its absence is a deliberate safety property and is
    // asserted rather than left to reviewer memory.
    // Asserted against the EXECUTABLE source, not the file: the header
    // deliberately names listDirectoryPeople at length to explain why it is
    // absent, and that prose must not be what keeps this test green.
    const src = fs
      .readFileSync(path.join(__dirname, 'lib.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(src).not.toContain('listDirectoryPeople');
    for (const name of Object.keys(lib)) {
      expect(name).not.toMatch(/^(list|enumerate|dump|all)/i);
    }
  });
});
