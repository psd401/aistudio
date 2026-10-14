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

/**
 * Duplicate-prevention guidance (#1889).
 *
 * The broker now refuses a name collision (`name_conflict`) and a likely
 * duplicate (`possible_duplicate`), both HTTP 409 with the existing schedule's
 * id. That only stops duplicates if the SKILL.md tells the agent to list
 * first, to update rather than re-create, and to retire the schedule it is
 * replacing — the old behaviour was to retry the failed create under a new
 * name, which is exactly how one counselor got four form watchers in a day.
 */
describe('duplicate-prevention guidance', () => {
  test('tells the agent to list before create', () => {
    expect(SKILL).toMatch(/Run `list` before every `create`/);
  });

  test('tells the agent to update rather than create a second schedule', () => {
    expect(SKILL).toContain('Never create a second schedule for the same job');
    expect(SKILL).toMatch(/Creating is not how you change a schedule/);
  });

  test('tells the agent to retire the schedule it replaces', () => {
    // Semantic, not prose-shaped: the replacement guidance must name both
    // ways to retire the old schedule, in whatever wording it uses.
    const section = SKILL.slice(
      SKILL.indexOf('Never create a second schedule for the same job')
    );
    expect(section).toMatch(/\bdelete\b/);
    expect(section).toMatch(/--enabled false/);
    expect(section).toMatch(/\bfirst\b/);
  });

  test('documents both refusal codes the broker returns', () => {
    expect(SKILL).toContain('name_conflict');
    expect(SKILL).toContain('possible_duplicate');
    expect(SKILL).toMatch(/existingScheduleId/);
  });

  test('documents --confirm-new and warns against using it to bypass errors', () => {
    expect(SKILL).toContain('--confirm-new');
    expect(SKILL).toMatch(/It is \*\*not\*\* the way past an\s*\n?error/);
  });

  test('matches the flag create.js actually accepts', () => {
    const create = fs.readFileSync(path.join(__dirname, 'create.js'), 'utf8');
    expect(create).toContain("args['confirm-new']");
    expect(create).toContain('confirmNew:');
    expect(create).toContain('[--confirm-new]');
  });
});
