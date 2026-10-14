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
 * Only `firstPersonalDataKind` is here because only chat-chart uses this
 * loader, and its rule is "refuse on any match". The public-file thresholds
 * are the broker's (lib/safety/personal-data-scan.ts) and the narration rule
 * is psd-tts's (infra/agent-image/personal_data.py); neither runs in Node in
 * the image. tests/fixtures/personal-data-cases.json is run through all three
 * loaders so they cannot drift apart on what the patterns match.
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
  // Non-global, so `.test()` carries no lastIndex state between calls.
  // eslint-disable-next-line security/detect-non-literal-regexp
  test: new RegExp(raw.source, 'i'),
}));

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

module.exports = {
  firstPersonalDataKind,
  PERSONAL_DATA_PATTERN_COUNT: PATTERNS.length,
};
