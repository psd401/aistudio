'use strict';

/**
 * personal-data.js — the agent image's reader for the canonical personal-data
 * patterns. Issue #1886.
 *
 * The regexes are NOT written here. They live in
 * `lib/safety/personal-data-patterns.json`, which the Next.js broker imports
 * directly and which `build-and-push.sh` stages into this directory as
 * `personal-data-patterns.json` for the image. Before #1886 the same four
 * patterns were hand-maintained in three places (chat-chart's run.js, the app's
 * lib/safety/types.ts, and nowhere at all on the upload path) and two of the
 * three were already drifting.
 *
 * Two policies, and they differ on purpose:
 *
 *   publicFile  a text-extractable file about to get an unsigned public URL.
 *               One contact detail is normal public content (the school phone
 *               number in a flyer footer); two or more is a contact list.
 *   narration   text about to be synthesised into an MP3 that is public by
 *               link with no expiry, and opaque to every later text check.
 *               Refuses on the first match of anything.
 */

const path = require('node:path');

function loadPatternFile() {
  const candidates = [
    // In the image: staged beside this file, shipped to /opt/psd-skills/_shared.
    path.join(__dirname, 'personal-data-patterns.json'),
    // In the repo (tests, local runs): the canonical committed copy.
    path.join(__dirname, '..', '..', '..', '..', 'lib', 'safety', 'personal-data-patterns.json'),
  ];
  for (const candidate of candidates) {
    try {
      // `require` rather than a validated-fs read: this is a module, not user
      // data, and the module loader caches it for the life of the process.
      return require(candidate);
    } catch (err) {
      if (err && err.code !== 'MODULE_NOT_FOUND') throw err;
    }
  }
  throw new Error(
    'personal-data-patterns.json not found. In the image it is staged into ' +
      '/opt/psd-skills/_shared by build-and-push.sh; in the repo it is ' +
      'lib/safety/personal-data-patterns.json.'
  );
}

const PATTERN_FILE = loadPatternFile();

const PATTERNS = PATTERN_FILE.patterns.map((raw) => ({
  kind: raw.kind,
  // Patterns come only from the versioned, source-controlled policy file, the
  // same arrangement path-policy.ts uses for workspace-policy.json.
  // Separate objects: `test` must not share lastIndex with the global form.
  // eslint-disable-next-line security/detect-non-literal-regexp
  test: new RegExp(raw.source, 'i'),
  // eslint-disable-next-line security/detect-non-literal-regexp
  all: new RegExp(raw.source, 'gi'),
}));

const POLICIES = {
  publicFile: PATTERN_FILE.publicFileMinDistinct,
  narration: PATTERN_FILE.narrationMinDistinct,
};

/**
 * The first kind of personal data the text contains, or null.
 *
 * Short-circuits on the first matching pattern. chat-chart's quickchart gate
 * uses this: it refuses on any match at all, and a 120KB payload has to stay
 * under a second (see run.test.js — the pattern file's bounded quantifiers are
 * what keep the scan linear, so do not loosen them).
 */
function firstPersonalDataKind(text) {
  for (const pattern of PATTERNS) {
    if (pattern.test.test(text)) return pattern.kind;
  }
  return null;
}

function distinctCount(text, kind) {
  const values = new Set();
  for (const pattern of PATTERNS) {
    if (pattern.kind !== kind) continue;
    for (const match of text.matchAll(pattern.all)) {
      values.add(match[0].toLowerCase());
    }
  }
  return values.size;
}

/**
 * The kinds that make this text unfit for `policyName` ('publicFile' or
 * 'narration'), sorted. Never the matched values — those must not travel into a
 * log line or an error message.
 */
function personalDataKinds(text, policyName) {
  const minimums = POLICIES[policyName];
  if (!minimums) throw new Error(`Unknown personal-data policy: ${policyName}`);
  const kinds = new Set();
  for (const pattern of PATTERNS) {
    if (kinds.has(pattern.kind)) continue;
    const minimum = minimums[pattern.kind];
    if (typeof minimum !== 'number') continue;
    // Threshold 1 needs no counting, which keeps the common case a single
    // short-circuiting `.test()` per pattern.
    if (minimum <= 1) {
      if (pattern.test.test(text)) kinds.add(pattern.kind);
    } else if (distinctCount(text, pattern.kind) >= minimum) {
      kinds.add(pattern.kind);
    }
  }
  return [...kinds].sort();
}

module.exports = {
  firstPersonalDataKind,
  personalDataKinds,
  PERSONAL_DATA_PATTERN_COUNT: PATTERNS.length,
};
