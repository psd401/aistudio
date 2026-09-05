/**
 * psd-schedules SKILL.md authoring-rule tests.
 *
 * Run: bun test authoring-rules.test.js   (from this directory)
 *
 * Two rules in this SKILL.md are load-bearing enough that losing them costs
 * real production runs, and both are invisible to any other check:
 *
 *   1. A scheduled run's final REPLY is the DM delivery. A prompt that instead
 *      hunts for the owner's DM space (`chat spaces.findDirectMessage` ->
 *      `chat spaces list` -> `chat +send`) fails the whole run for a digest
 *      the reply path was already delivering — six consecutive days of it in
 *      prod. The rule is narrow: `chat +send` to a SHARED space is still
 *      correct, so the text has to say BOTH halves.
 *
 *   2. The broker's read/write split. `list`/`runs` are reachable from a
 *      scheduled run; `create`/`update`/`delete` are owner-mode only. If
 *      app/api/agent/schedules/route.ts widens or narrows that set, this
 *      documentation goes stale silently — the agent would either keep
 *      believing it cannot audit, or start believing it can mutate.
 */

'use strict';

const { test, expect, describe } = require('bun:test');
const fs = require('node:fs');
const path = require('node:path');

const SKILL = fs.readFileSync(path.join(__dirname, 'SKILL.md'), 'utf8');
const ROUTE = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'app',
  'api',
  'agent',
  'schedules',
  'route.ts'
);

describe('delivery rule', () => {
  test('says the reply is the delivery', () => {
    expect(SKILL).toContain('The reply IS the delivery');
    expect(SKILL).toMatch(/never write DM-space discovery into a schedule prompt/i);
  });

  test('names the exact discovery calls that must not be scripted', () => {
    expect(SKILL).toContain('spaces.findDirectMessage');
    expect(SKILL).toContain('chat spaces list');
  });

  test('keeps shared-space sends explicitly legitimate', () => {
    // Without this half the rule reads as "never send chat", which would break
    // every schedule whose job is to post into a team space.
    expect(SKILL).toMatch(
      /`chat \+send` to a SHARED space stays completely legitimate/
    );
  });
});

describe('scheduled-run capability documentation', () => {
  test('documents read-allowed and write-refused', () => {
    expect(SKILL).toMatch(/`list\.js`, `runs\.js` \| \*\*Allowed\*\*/);
    expect(SKILL).toMatch(
      /`create\.js`, `update\.js`, `delete\.js` \| \*\*Refused \(403\)\*\*/
    );
  });

  test('matches the broker route it describes', () => {
    const route = fs.readFileSync(ROUTE, 'utf8');
    const declared = route.match(
      /SCHEDULED_READ_OPERATIONS = new Set<ScheduledReadOperation>\(\[([^\]]*)\]\)/
    );
    expect(declared).not.toBeNull();
    const operations = declared[1]
      .split(',')
      .map((entry) => entry.trim().replace(/^"|"$/g, ''))
      .filter(Boolean)
      .sort();
    expect(operations).toEqual(['list', 'runs']);
  });
});
