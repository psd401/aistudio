'use strict';

const { afterEach, describe, expect, test } = require('bun:test');
const os = require('node:os');
const path = require('node:path');
const { validatedFs } = require('../../../validated-fs.cjs');

const {
  BriefError,
  applyRetention,
  composeBrief,
  computeLeadStory,
  createPrivateAtriumArtifact,
  dayWindow,
  deterministicSynthesis,
  gatherSnapshot,
  main,
  makeSynthesisRequest,
  normalizeConfig,
  reportFailure,
  selfCheck,
  validateSynthesis,
  writeSnapshot,
} = require('./run');
const {
  DEFAULT_EMPTY_MESSAGES,
  escapeHtml,
  renderNewspaper,
  safeUrl,
} = require('./newspaper');

const scratch = [];

function makeTempDir() {
  const dir = validatedFs.mkdtempSync(
    path.join(os.tmpdir(), 'brief-test-'),
  );
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.PSD_MORNING_BRIEF_STATE_DIR;
  for (const dir of scratch.splice(0)) {
    validatedFs.rmSync(dir, { recursive: true, force: true });
  }
});

function snapshotFixture() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-29T14:00:00.000Z',
    localDate: '2026-07-29',
    displayDate: 'Wednesday, July 29, 2026',
    timezone: 'America/Los_Angeles',
    title: 'Morning Brief — 2026-07-29',
    people: [],
    omittedSections: [],
    sections: [
      {
        id: 'calendar',
        title: "Today's calendar",
        status: 'ok',
        emptyMessage: DEFAULT_EMPTY_MESSAGES.calendar,
        data: {
          events: [
            {
              title: 'Planning meeting',
              start: '2026-07-29T09:00:00-07:00',
            },
          ],
        },
      },
      {
        id: 'custom-focus',
        title: 'Strategic focus',
        custom: true,
        status: 'awaiting-synthesis',
        emptyMessage: 'No strategic update was gathered.',
        data: {
          instructions: 'Summarize changes.',
          sources: ['psd-data'],
        },
      },
    ],
  };
}

function synthesisFixture() {
  return {
    headline: 'A focused day ahead',
    subheadline: 'One scheduled decision anchors the day.',
    leadStory: {
      sectionId: 'calendar',
      headline: 'Planning meeting leads the agenda',
      summary: 'Prepare the decision packet before 9:00.',
    },
    sections: [
      {
        id: 'calendar',
        title: "Today's calendar",
        summary: 'One meeting.',
        items: [
          {
            headline: 'Planning meeting',
            body: 'Review the decision packet.',
          },
        ],
      },
      {
        id: 'custom-focus',
        title: 'Strategic focus',
        summary: 'The custom desk is current.',
        items: [{ headline: 'Initiative update', body: 'On track.' }],
      },
    ],
    inboxDecisions: [],
    podcastScript:
      'Good morning. Here is the complete spoken edition for today.',
  };
}

describe('configuration and self-check', () => {
  test('no config input produces complete safe defaults', () => {
    const config = normalizeConfig();
    expect(config.enabledSections).toHaveLength(8);
    expect(config.podcast.enabled).toBe(true);
    expect(config.retainDays).toBe(30);
    expect(config.news.topics.length).toBeGreaterThan(0);
  });

  test('custom sections are normalized into first-class stable ids', () => {
    const config = normalizeConfig({
      customSections: [
        {
          title: 'Project pulse',
          instructions: 'Gather decisions and blockers.',
          sources: ['psd-data', 'psd-plaud'],
        },
      ],
    });
    expect(config.customSections).toEqual([
      {
        id: 'custom-project-pulse',
        title: 'Project pulse',
        instructions: 'Gather decisions and blockers.',
        sources: ['psd-data', 'psd-plaud'],
      },
    ]);
  });

  test('an explicit empty enabled-section list supports custom-only briefs', () => {
    expect(normalizeConfig({ enabledSections: [] }).enabledSections).toEqual(
      [],
    );
  });

  test('calendar bounds follow the configured timezone across DST', () => {
    expect(dayWindow('2026-07-29', 'America/Los_Angeles')).toEqual({
      timeMin: '2026-07-29T07:00:00.000Z',
      timeMax: '2026-07-30T07:00:00.000Z',
    });
    expect(dayWindow('2026-01-29', 'America/Los_Angeles')).toEqual({
      timeMin: '2026-01-29T08:00:00.000Z',
      timeMax: '2026-01-30T08:00:00.000Z',
    });
  });

  test('--test self-check is offline and passes', () => {
    expect(selfCheck()).toMatchObject({
      status: 'ok',
      mode: 'test',
      offline: true,
    });
  });

  test('authority selector flags are rejected', async () => {
    await expect(
      main(
        [
          'node',
          'run.js',
          '--owner-email',
          'alternate@example.net',
          '--data-only',
        ],
        {},
      ),
    ).rejects.toMatchObject({
      code: 'bad_args',
      phase: 'arguments',
    });
  });

  test('ambiguous mode combinations are rejected', async () => {
    await expect(
      main(
        [
          'node',
          'run.js',
          '--user',
          'owner@example.net',
          '--data-only',
          '--both',
        ],
        {},
      ),
    ).rejects.toMatchObject({
      code: 'bad_args',
      phase: 'arguments',
    });
  });

  test('no config file still completes a private newspaper run', async () => {
    const dir = makeTempDir();
    process.env.PSD_MORNING_BRIEF_STATE_DIR = dir;
    const emitted = [];
    const result = await main(
      [
        'node',
        'run.js',
        '--user',
        'owner@example.net',
        '--both',
      ],
      {
        now: new Date('2026-07-29T14:00:00.000Z'),
        emit: (value) => emitted.push(value),
        registry: [
          {
            id: 'calendar',
            title: "Today's calendar",
            available: async () => true,
            fetch: async () => ({ events: [] }),
          },
        ],
        runExternal: () => ({
          code: 0,
          stdout: JSON.stringify({
            status: 'ok',
            url: 'https://example.net/audio/default.mp3',
            voice: 'Ruth',
            engine: 'long-form',
          }),
          stderr: '',
        }),
        broker: async () => ({
          httpStatus: 201,
          payload: {
            data: {
              id: 'default-brief',
              slug: 'morning-brief-2026-07-29',
              title: 'Morning Brief — 2026-07-29',
              visibilityLevel: 'private',
              url: 'https://example.net/c/morning-brief-2026-07-29',
            },
          },
        }),
      },
    );
    expect(result.artifact.visibility).toBe('private');
    expect(result.podcast.enabled).toBe(true);
    expect(result.deliveryMessage).toContain(
      'https://example.net/c/morning-brief-2026-07-29',
    );
    expect(emitted).toEqual([result]);
  });
});

describe('section availability and synthesis request', () => {
  test('unavailable core sections are omitted from snapshot and request', async () => {
    const registry = [
      {
        id: 'calendar',
        title: 'Calendar',
        available: async () => true,
        fetch: async () => ({ events: [] }),
      },
      {
        id: 'inbox',
        title: 'Inbox',
        available: async () => false,
        fetch: async () => {
          throw new Error('must not run');
        },
      },
    ];
    const config = normalizeConfig({
      enabledSections: ['calendar', 'inbox'],
      customSections: [
        {
          title: 'Project pulse',
          instructions: 'Gather changes.',
          sources: ['psd-data'],
        },
      ],
      people: [],
    });
    const snapshot = await gatherSnapshot(
      {
        user: 'owner@example.net',
        config,
        now: new Date('2026-07-29T14:00:00.000Z'),
      },
      {
        registry,
        broker: async () => {
          throw new Error('unexpected broker call');
        },
      },
    );
    expect(snapshot.sections.map((section) => section.id)).toEqual([
      'calendar',
      'custom-project-pulse',
    ]);
    expect(snapshot.omittedSections).toContainEqual(
      expect.objectContaining({ id: 'inbox' }),
    );
    expect(
      makeSynthesisRequest(snapshot).availableSections.map(
        (section) => section.id,
      ),
    ).not.toContain('inbox');
  });

  test('configured people are resolved only through the directory broker', async () => {
    const calls = [];
    const snapshot = await gatherSnapshot(
      {
        user: 'owner@example.net',
        config: normalizeConfig({
          enabledSections: ['calendar'],
          people: [{ email: 'person@example.net', note: 'Collaborator' }],
        }),
        now: new Date('2026-07-29T14:00:00.000Z'),
      },
      {
        registry: [
          {
            id: 'calendar',
            title: 'Calendar',
            available: async () => true,
            fetch: async () => ({ events: [] }),
          },
        ],
        broker: async (route, payload) => {
          calls.push({ route, payload });
          return {
            found: true,
            displayName: 'Directory Person',
            email: payload.email,
          };
        },
      },
    );
    expect(calls).toEqual([
      {
        route: '/api/agent/directory-lookup',
        payload: { email: 'person@example.net' },
      },
    ]);
    expect(snapshot.people[0].displayName).toBe('Directory Person');
  });

  test('snapshot writer returns a usable data path', () => {
    const dir = makeTempDir();
    const snapshot = snapshotFixture();
    const result = writeSnapshot(
      snapshot,
      makeSynthesisRequest(snapshot),
      dir,
    );
    expect(result.dataFile).toBe(path.join(dir, 'data.json'));
    expect(
      JSON.parse(validatedFs.readFileSync(result.dataFile, 'utf8')).title,
    ).toBe(snapshot.title);
    expect(result.synthesisRequest.dataFile).toBe(result.dataFile);
  });
});

describe('synthesis and newspaper', () => {
  test('podcast-enabled synthesis requires a complete script', () => {
    const snapshot = snapshotFixture();
    expect(() =>
      validateSynthesis(
        { ...synthesisFixture(), podcastScript: '' },
        snapshot,
        normalizeConfig(),
      ),
    ).toThrow(BriefError);
  });

  test('configured custom sections cannot be silently dropped', () => {
    const snapshot = snapshotFixture();
    const missingCustom = {
      ...synthesisFixture(),
      sections: synthesisFixture().sections.filter(
        (section) => section.id !== 'custom-focus',
      ),
    };
    expect(() =>
      validateSynthesis(
        missingCustom,
        snapshot,
        normalizeConfig(),
      ),
    ).toThrow(/missing configured custom section/);
  });

  test('every gathered inbox item receives a valid decision', () => {
    const snapshot = snapshotFixture();
    snapshot.sections.push({
      id: 'inbox',
      title: 'Inbox triage',
      status: 'ok',
      data: { emails: [{ id: 'message-1', subject: 'A decision' }] },
    });
    expect(() =>
      validateSynthesis(
        synthesisFixture(),
        snapshot,
        normalizeConfig(),
      ),
    ).toThrow(/decision for every inbox item/);
    const deterministic = deterministicSynthesis(
      snapshot,
      normalizeConfig(),
    );
    expect(
      validateSynthesis(deterministic, snapshot, normalizeConfig())
        .inboxDecisions,
    ).toEqual([
      {
        messageId: 'message-1',
        decision: 'review',
        rationale: 'Review this message in the inbox.',
      },
    ]);
  });

  test('custom source instructions are not rendered as fallback content', () => {
    const snapshot = snapshotFixture();
    const html = renderNewspaper({
      snapshot,
      synthesis: {
        ...synthesisFixture(),
        sections: [],
      },
      podcast: { enabled: false },
    });
    expect(html).not.toContain('Summarize changes.');
  });

  test('custom sections render as newspaper desks and empty core states are clean', () => {
    const snapshot = snapshotFixture();
    snapshot.sections[0] = {
      ...snapshot.sections[0],
      status: 'empty',
      data: { events: [] },
    };
    const synthesis = {
      ...synthesisFixture(),
      sections: synthesisFixture().sections.filter(
        (section) => section.id === 'custom-focus',
      ),
    };
    const html = renderNewspaper({
      snapshot,
      synthesis,
      podcast: { enabled: false },
    });
    expect(html).toContain('Custom desk');
    expect(html).toContain('Strategic focus');
    expect(html).toContain(DEFAULT_EMPTY_MESSAGES.calendar);
  });

  test('HTML and unsafe URLs are escaped instead of executed', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
    expect(safeUrl('javascript:alert(1)')).toBeNull();
  });

  test('lead story scoring generalizes across enabled sections', () => {
    const snapshot = snapshotFixture();
    snapshot.sections.push({
      id: 'freshservice',
      title: 'Service desk',
      data: {
        tickets: [
          { subject: 'Critical overdue approval' },
          { subject: 'Urgent incident' },
        ],
      },
    });
    expect(
      computeLeadStory(snapshot, {
        calendar: 1,
        freshservice: 6,
      }).sectionId,
    ).toBe('freshservice');
  });
});

describe('Atrium delivery and podcast', () => {
  test('Atrium create is explicit private create with no authority selector or publish', async () => {
    const calls = [];
    const created = await createPrivateAtriumArtifact(
      snapshotFixture(),
      '<!doctype html><p>brief</p>',
      async (route, payload) => {
        calls.push({ route, payload });
        return {
          httpStatus: 201,
          payload: {
            data: {
              id: 'brief-id',
              slug: 'morning-brief-2026-07-29',
              title: 'Morning Brief — 2026-07-29',
              visibilityLevel: 'private',
              url: 'https://example.net/c/morning-brief-2026-07-29',
            },
          },
        };
      },
    );
    expect(created.id).toBe('brief-id');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      route: '/api/agent/atrium',
      payload: {
        method: 'POST',
        path: '',
        body: {
          kind: 'artifact',
          bodyFormat: 'html',
          codeEncoding: 'base64',
          visibility: { level: 'private' },
        },
      },
    });
    expect(JSON.stringify(calls[0].payload)).not.toMatch(
      /ownerEmail|userEmail|userId|publish/,
    );
  });

  test('missing Atrium capability is a hard failure with no fallback', async () => {
    await expect(
      createPrivateAtriumArtifact(
        snapshotFixture(),
        '<!doctype html>',
        async () => ({
          httpStatus: 403,
          payload: {
            error: {
              code: 'FORBIDDEN',
              message: 'Atrium authoring capability is required',
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'atrium_delivery_failed',
      phase: 'atrium',
    });
  });

  test('compose generates podcast by default and returns both DM links', async () => {
    const dir = makeTempDir();
    process.env.PSD_MORNING_BRIEF_STATE_DIR = dir;
    const externalCalls = [];
    const brokerCalls = [];
    const result = await composeBrief(
      {
        user: 'owner@example.net',
        config: normalizeConfig(),
        snapshot: snapshotFixture(),
        synthesis: synthesisFixture(),
      },
      {
        runExternal: (spec) => {
          externalCalls.push(spec);
          return {
            code: 0,
            stdout: JSON.stringify({
              status: 'ok',
              url: 'https://example.net/audio/today.mp3',
              voice: 'Ruth',
              engine: 'long-form',
            }),
            stderr: '',
          };
        },
        broker: async (route, payload) => {
          brokerCalls.push({ route, payload });
          return {
            httpStatus: 201,
            payload: {
              data: {
                id: 'brief-id',
                slug: 'morning-brief-2026-07-29',
                title: 'Morning Brief — 2026-07-29',
                visibilityLevel: 'private',
                url: 'https://example.net/c/morning-brief-2026-07-29',
              },
            },
          };
        },
      },
    );
    expect(externalCalls[0]).toMatchObject({
      skill: 'tts',
      args: expect.arrayContaining(['--engine', 'long-form']),
    });
    expect(result.deliveryMessage).toContain(
      'https://example.net/c/morning-brief-2026-07-29',
    );
    expect(result.deliveryMessage).toContain(
      'https://example.net/audio/today.mp3',
    );
    expect(brokerCalls).toHaveLength(1);
  });

  test('per-user config can disable podcast generation', async () => {
    const dir = makeTempDir();
    process.env.PSD_MORNING_BRIEF_STATE_DIR = dir;
    const config = normalizeConfig({ podcast: { enabled: false } });
    const result = await composeBrief(
      {
        user: 'owner@example.net',
        config,
        snapshot: snapshotFixture(),
        synthesis: { ...synthesisFixture(), podcastScript: '' },
      },
      {
        runExternal: () => {
          throw new Error('TTS must not run');
        },
        broker: async () => ({
          httpStatus: 201,
          payload: {
            data: {
              id: 'brief-id',
              slug: 'brief',
              title: 'Morning Brief — 2026-07-29',
              visibilityLevel: 'private',
              url: 'https://example.net/c/brief',
            },
          },
        }),
      },
    );
    expect(result.podcast.enabled).toBe(false);
    expect(result.deliveryMessage).not.toContain('.mp3');
  });

});

describe('retention and failures', () => {
  test('retention deletes only ledger-tracked briefs older than retainDays', async () => {
    const dir = makeTempDir();
    process.env.PSD_MORNING_BRIEF_STATE_DIR = dir;
    validatedFs.writeFileSync(
      path.join(dir, 'briefs.json'),
      JSON.stringify([
        {
          id: 'old-owned',
          createdAt: '2026-06-01T12:00:00.000Z',
          localDate: '2026-06-01',
        },
        {
          id: 'recent-owned',
          createdAt: '2026-07-28T12:00:00.000Z',
          localDate: '2026-07-28',
        },
      ]),
    );
    const calls = [];
    const retention = await applyRetention(
      { id: 'today', slug: 'today' },
      snapshotFixture(),
      normalizeConfig({ retainDays: 30 }),
      async (route, payload) => {
        calls.push({ route, payload });
        return { httpStatus: 200, payload: { data: { deleted: true } } };
      },
    );
    expect(calls).toEqual([
      {
        route: '/api/agent/atrium',
        payload: { method: 'DELETE', path: '/old-owned' },
      },
    ]);
    expect(retention.deleted).toEqual(['old-owned']);
    const ledger = JSON.parse(
      validatedFs.readFileSync(path.join(dir, 'briefs.json'), 'utf8'),
    );
    expect(ledger.map((entry) => entry.id)).toEqual([
      'recent-owned',
      'today',
    ]);
  });

  test('fatal failure reporting contains no model-supplied owner selector', async () => {
    const calls = [];
    await reportFailure(
      new BriefError('Delivery failed', 'delivery_failed', 'atrium'),
      {
        broker: async (route, payload) => {
          calls.push({ route, payload });
          return { logged: true };
        },
      },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].route).toBe('/api/agent/failures');
    expect(calls[0].payload.context).toMatchObject({
      skill: 'psd-morning-brief',
      phase: 'atrium',
    });
    expect(JSON.stringify(calls[0].payload)).not.toMatch(
      /ownerEmail|userEmail|userId/,
    );
  });
});
