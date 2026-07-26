/**
 * psd-schedules SKILL.md registration tests.
 *
 * Run: bun test skill-frontmatter.test.js   (from this directory, or via
 *      `bun run test:skill:schedules` at the repo root)
 *
 * These guard DISCOVERABILITY, which for this skill is a correctness property
 * rather than polish. Two mechanisms have to line up:
 *
 *   1. infra/lib/agent-platform-stack.ts parses this frontmatter at deploy
 *      time and registers `summary || `Bundled skill: ${name}``. A missing
 *      summary is therefore not an empty column — it is a placeholder that
 *      contains no searchable words.
 *   2. psd-skills-meta/common.js implements skills.search as
 *      `WHERE name ILIKE '%q%' OR summary ILIKE '%q%'` — NAME and SUMMARY
 *      only, never description.
 *
 * Net effect when the summary is absent: the agent can reach the scheduling
 * skill only by searching the literal string "schedules". "remind me", "cron",
 * "recurring", "daily brief", "follow up" all return zero rows even though the
 * description covers exactly those cases. That is the bug these tests pin.
 */

'use strict';

const { test, expect, describe } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Parse SKILL.md frontmatter with the SAME regexes agent-platform-stack.ts
 * uses. Deliberately not a general YAML parser: what matters is what the
 * registration path actually extracts, not what a stricter parser could.
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

// What the stack would UPSERT into psd_agent_skills.summary.
function registeredSummary(fields) {
  return fields.summary || `Bundled skill: ${fields.name}`;
}

describe('SKILL.md registration frontmatter', () => {
  test('declares name, summary and description', () => {
    const fm = parseFrontmatterAsStackDoes();
    expect(fm.name).toBe('psd-schedules');
    expect(fm.summary.length).toBeGreaterThan(0);
    expect(fm.description.length).toBeGreaterThan(0);
  });

  test('registers a real summary, not the "Bundled skill:" placeholder', () => {
    const fm = parseFrontmatterAsStackDoes();
    expect(registeredSummary(fm)).not.toBe('Bundled skill: psd-schedules');
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
});

describe('skills.search discoverability', () => {
  // Simulates `name ILIKE '%q%' OR summary ILIKE '%q%'`. ILIKE is
  // case-insensitive substring matching, so lowercased .includes() is the
  // faithful equivalent for these ASCII terms.
  const searchable = () => {
    const fm = parseFrontmatterAsStackDoes();
    return `${fm.name} ${registeredSummary(fm)}`.toLowerCase();
  };

  // The queries an agent would actually type when it needs to defer work.
  // Not cosmetic: summary is the only free-text field skills.search reads.
  //
  // Multi-word entries are here deliberately. ILIKE '%q%' matches ONE
  // contiguous substring, not a bag of words, so "daily brief" only hits if
  // that exact phrase appears — "daily or weekly brief" would not match it.
  const QUERY_TERMS = [
    'remind',
    'remind me',
    'reminder',
    'cron',
    'cron job',
    'recurring',
    'schedule',
    'later',
    'follow up',
    'daily',
    'daily brief',
    'morning brief',
    'weekly',
    'weekly brief',
    'brief',
  ];

  for (const term of QUERY_TERMS) {
    test(`a search for "${term}" finds this skill`, () => {
      expect(searchable()).toContain(term);
    });
  }

  test('description text is NOT what makes those queries match', () => {
    // Guards against a future edit that "fixes" discoverability by enriching
    // the description — which skills.search never reads.
    const fm = parseFrontmatterAsStackDoes();
    const withoutSummary = `${fm.name} Bundled skill: ${fm.name}`.toLowerCase();
    const stillFound = QUERY_TERMS.filter((t) => withoutSummary.includes(t));
    expect(stillFound).toEqual(['schedule']);
  });
});
