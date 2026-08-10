/**
 * psd-open-adaptive-district SKILL.md registration tests.
 *
 * Run: bun test skill-frontmatter.test.js  (or `bun run test:skill:oad`)
 *
 * These guard DISCOVERABILITY, which for this skill is correctness, not polish.
 * Two mechanisms have to line up:
 *
 *   1. infra/lib/agent-platform-stack.ts parses this frontmatter at deploy time
 *      and registers `summary || `Bundled skill: ${name}``. A missing summary is
 *      not an empty column — it is a placeholder containing no searchable words.
 *   2. psd-skills-meta/common.js implements skills.search as
 *      `WHERE name ILIKE '%q%' OR summary ILIKE '%q%'` — NAME and SUMMARY only,
 *      never description.
 *
 * This skill has a second job beyond explaining the current model: the Open
 * Adaptive District was re-authored with an entirely new vocabulary, and staff
 * who read the first-draft documents still ask in the retired terms. If those
 * retired phrases live only in `description`, a search for "Bet Brief" returns
 * zero rows and the agent answers from nothing instead of translating. So the
 * retired phrases have to be in SUMMARY, and a test is the only thing that
 * notices when a future edit tidies them back out.
 */

'use strict';

const { test, expect, describe } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Parse SKILL.md frontmatter with the SAME regexes agent-platform-stack.ts
 * uses. Deliberately not a general YAML parser: what matters is what the
 * registration path actually extracts.
 */
function parseFrontmatterAsStackDoes() {
  const raw = fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  expect(fm).not.toBeNull();

  const fields = { name: '', summary: '', description: '' };
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^(name|summary|description):\s*(.*)$/);
    if (!m) continue;
    fields[m[1]] = m[2].trim();
  }
  return fields;
}

function registeredSummary(fields) {
  return fields.summary || `Bundled skill: ${fields.name}`;
}

describe('SKILL.md registration frontmatter', () => {
  test('declares name, summary and description', () => {
    const fm = parseFrontmatterAsStackDoes();
    expect(fm.name).toBe('psd-open-adaptive-district');
    expect(fm.summary.length).toBeGreaterThan(0);
    expect(fm.description.length).toBeGreaterThan(0);
  });

  test('registers a real summary, not the "Bundled skill:" placeholder', () => {
    const fm = parseFrontmatterAsStackDoes();
    expect(registeredSummary(fm)).not.toBe(
      'Bundled skill: psd-open-adaptive-district',
    );
  });

  test('summary is a single line the stack can parse', () => {
    // The stack splits frontmatter on '\n' and matches per line, so a wrapped
    // summary would silently register only its first physical line.
    const raw = fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');
    const summaryLines = raw
      .match(/^---\n([\s\S]*?)\n---/)[1]
      .split('\n')
      .filter((l) => l.startsWith('summary:'));
    expect(summaryLines).toHaveLength(1);
    // A bare ': ' would make the line ambiguous to the YAML readers that also
    // consume this file, so keep the value colon-free.
    expect(summaryLines[0].slice('summary:'.length)).not.toContain(': ');
  });

  test('declares the read-only tool surface it actually uses', () => {
    const raw = fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');
    expect(raw).toContain('allowed-tools: Read');
  });
});

describe('skills.search discoverability', () => {
  // Simulates `name ILIKE '%q%' OR summary ILIKE '%q%'`. ILIKE is
  // case-insensitive substring matching, so lowercased .includes() is the
  // faithful equivalent for these ASCII terms.
  const searchable = () => {
    const fm = parseFrontmatterAsStackDoes();
    return `${fm.name} ${registeredSummary(fm)}`.toLowerCase();
  };

  // Multi-word entries are deliberate: ILIKE '%q%' matches ONE contiguous
  // substring, not a bag of words, so a phrase only hits if it appears intact.
  const CURRENT_TERMS = [
    'open adaptive district',
    'build cycle',
    'build plan',
    'weekly check-in',
    'wrap-up',
    'quarterly focus',
  ];

  // The retired first-draft vocabulary. Staff who read the earlier documents
  // still search these, and the skill exists partly to translate them.
  const RETIRED_TERMS = [
    'ship cycle',
    'bet brief',
    'adoption',
    'decommission',
    'continuation',
    'quarterly intent',
  ];

  for (const term of [...CURRENT_TERMS, ...RETIRED_TERMS]) {
    test(`a search for "${term}" finds this skill`, () => {
      expect(searchable()).toContain(term);
    });
  }

  test('description text is NOT what makes those queries match', () => {
    // Guards against a future edit that "fixes" discoverability by enriching
    // the description — which skills.search never reads.
    const fm = parseFrontmatterAsStackDoes();
    const withoutSummary = `${fm.name} Bundled skill: ${fm.name}`.toLowerCase();
    const stillFound = [...CURRENT_TERMS, ...RETIRED_TERMS].filter((t) =>
      withoutSummary.includes(t),
    );
    // The hyphenated skill name contains none of these phrases intact.
    expect(stillFound).toEqual([]);
  });
});

describe('retired vocabulary is translated, not resurrected', () => {
  const skill = () =>
    fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');

  test('every retired term the summary advertises has a table row', () => {
    // If a term is searchable but unmapped, the skill loads and then has
    // nothing to say about the phrase that found it.
    const body = skill();
    for (const retired of [
      'SHIP cycle',
      'Bet Brief',
      'Adoption Brief',
      'Decommission Brief',
      'Continuation Brief',
      'Quarterly Intent',
    ]) {
      expect(body).toContain(`| ${retired} |`);
    }
  });

  test('cites no reference or template file that was deleted', () => {
    const body = skill();
    for (const gone of [
      'quick-guide.md',
      'doctrine-primer.md',
      'bet-writing-primer.md',
      'onboarding-guide.md',
      'kickoff-facilitator-guide.md',
      'kickoff-slides.md',
      'bet-brief.md',
      'adoption-brief.md',
      'decommission-brief.md',
      'continuation-brief.md',
      'quarterly-intent.md',
      'cabinet-weekly-read.md',
      'quarterly-synthesis.md',
    ]) {
      expect(body).not.toContain(gone);
    }
  });

  // Directories are listed once from all-literal paths rather than probed per
  // candidate, so the check never builds an fs path out of file content.
  test('every templates/ path SKILL.md cites exists on disk', () => {
    const onDisk = new Set(
      fs.readdirSync(path.join(__dirname, 'references', 'templates')),
    );
    const cited = [...skill().matchAll(/`templates\/([a-z0-9-]+\.md)`/g)].map(
      (m) => m[1],
    );
    expect(cited.length).toBeGreaterThan(0);
    for (const file of new Set(cited)) {
      expect(onDisk).toContain(file);
    }
  });

  test('every references/ path SKILL.md cites exists on disk', () => {
    const onDisk = new Set(fs.readdirSync(path.join(__dirname, 'references')));
    const cited = [
      ...skill().matchAll(/`references\/([a-z0-9-]+\.md)`/g),
    ].map((m) => m[1]);
    expect(cited.length).toBeGreaterThan(0);
    for (const file of new Set(cited)) {
      expect(onDisk).toContain(file);
    }
  });
});
