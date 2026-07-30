'use strict';

const path = require('node:path');
const {
  aggregate,
  citationPages,
  factTokens,
  loadFixture,
  normalizeText,
  parseArgs,
  scoreFact,
  scoreQuestion,
  selectRepository,
} = require('./retrieval-eval');

const fixturePath = path.join(
  __dirname,
  'evals',
  'retrieval-cases.json',
);

function expectedPages(question) {
  return question.expected.flatMap((fact) => fact.pages);
}

describe('retrieval evaluation fixture', () => {
  const fixture = loadFixture(fixturePath);

  test('contains exactly 12 Class A and 8 Class B questions', () => {
    expect(fixture.questions).toHaveLength(20);
    expect(
      fixture.questions.filter((question) => question.class === 'A'),
    ).toHaveLength(12);
    expect(
      fixture.questions.filter((question) => question.class === 'B'),
    ).toHaveLength(8);
  });

  test('stores expected answers only as names, dates, and page numbers', () => {
    for (const question of fixture.questions) {
      for (const fact of question.expected) {
        expect(Object.keys(fact).sort()).toEqual(['date', 'name', 'pages']);
        expect(fact.name.length).toBeGreaterThan(0);
        expect(fact.date.length).toBeGreaterThan(0);
        expect(fact.pages.every(Number.isSafeInteger)).toBe(true);
      }
    }
  });

  test('covers all four publication parts', () => {
    const pages = new Set(fixture.questions.flatMap(expectedPages));
    expect([...pages].some((page) => page < 59)).toBe(true);
    expect(pages.has(59)).toBe(true);
    expect(pages.has(83)).toBe(true);
    expect([...pages].some((page) => page >= 87 && page <= 102)).toBe(true);
  });
});

describe('retrieval evaluation arguments', () => {
  test('requires a named environment and URL', () => {
    expect(() => parseArgs([])).toThrow('--environment is required');
    expect(() => parseArgs(['--environment', 'dev'])).toThrow(
      '--base-url is required',
    );
  });

  test('accepts HTTPS and resolves paths', () => {
    const parsed = parseArgs([
      '--environment',
      'dev',
      '--base-url',
      'https://dev.example.test/path',
      '--fixture',
      fixturePath,
      '--out',
      './report.json',
    ]);
    expect(parsed.environment).toBe('dev');
    expect(parsed.baseUrl).toBe('https://dev.example.test');
    expect(parsed.fixture).toBe(fixturePath);
    expect(parsed.out).toBe(path.resolve('./report.json'));
  });

  test('never accepts an API key value on the command line', () => {
    expect(() =>
      parseArgs([
        '--environment',
        'dev',
        '--base-url',
        'https://dev.example.test',
        '--api-key',
        'sk-secret',
      ]),
    ).toThrow('Unknown flag: --api-key');
  });
});

describe('fact matching and citation scoring', () => {
  test('normalizes month names, accents, punctuation, and following/after', () => {
    expect(normalizeText('Birth of the Báb — November 10')).toBe(
      'birth of the bab nov 10',
    );
    expect(
      normalizeText('Friday immediately following the fourth Thursday'),
    ).toBe('friday after the fourth thursday');
  });

  test('ignores connector words while retaining fact-bearing tokens', () => {
    expect(
      factTokens({
        name: 'Anniversary of the Mexican Revolution',
        date: 'Nov. 20, 2026',
      }),
    ).toEqual([
      'anniversary',
      'mexican',
      'revolution',
      'nov',
      '20',
      '2026',
    ]);
  });

  test('matches a fact only when its name and date tokens share one result', () => {
    const fact = {
      name: 'American Education Week',
      date: 'Nov. 16-20, 2026',
      pages: [38],
    };
    const prepared = [
      {
        tokens: new Set(
          normalizeText(
            '2026 Nov. 16-20 American Education Week',
          ).split(' '),
        ),
        pages: [38],
      },
    ];
    expect(scoreFact(fact, prepared)).toMatchObject({
      matched: true,
      citationCorrect: true,
      returnedPages: [38],
    });
  });

  test('reports a fact match separately from an incorrect citation', () => {
    const fact = {
      name: 'National PTA',
      date: 'June 18-21, 2026',
      pages: [90],
    };
    const prepared = [
      {
        tokens: new Set(
          normalizeText('2026 June 18-21 National PTA').split(' '),
        ),
        pages: [89],
      },
    ];
    expect(scoreFact(fact, prepared)).toMatchObject({
      matched: true,
      citationCorrect: false,
      returnedPages: [89],
    });
  });

  test('expands cited page ranges', () => {
    expect(citationPages({ citation: { page: 37, pageEnd: 39 } })).toEqual([
      37, 38, 39,
    ]);
  });

  test('sanitized case output never retains excerpts', () => {
    const question = {
      id: 'test',
      class: 'A',
      question: 'When is the test observance?',
      expected: [
        { name: 'Test Observance', date: 'Jan. 1, 2026', pages: [11] },
      ],
    };
    const scored = scoreQuestion(
      question,
      {
        results: [
          {
            excerpt: '2026 Jan. 1 Test Observance source-only context',
            citation: { page: 11 },
          },
        ],
      },
      12,
    );
    expect(scored.matchedFactCount).toBe(1);
    expect(scored.returnedPages).toEqual([11]);
    expect(JSON.stringify(scored)).not.toContain('source-only context');
    expect(JSON.stringify(scored)).not.toContain('excerpt');
  });

  test('records only deduplicated, ordered citation pages for diagnostics', () => {
    const scored = scoreQuestion(
      {
        id: 'pages',
        class: 'A',
        question: 'Which pages were returned?',
        expected: [
          { name: 'Missing fact', date: 'Jan. 1, 2026', pages: [11] },
        ],
      },
      {
        results: [
          { excerpt: 'unrelated', citation: { page: 42 } },
          { excerpt: 'unrelated', citation: { page: 7, pageEnd: 8 } },
          { excerpt: 'unrelated', citation: { page: 42 } },
        ],
      },
      12,
    );
    expect(scored.returnedPages).toEqual([7, 8, 42]);
  });
});

describe('decision rule', () => {
  function result(overrides) {
    return {
      class: 'A',
      correct: true,
      expectedFactCount: 1,
      matchedFactCount: 1,
      correctlyCitedFactCount: 1,
      ...overrides,
    };
  }

  test('requires investigation when Class A is below 90%', () => {
    const cases = [
      ...Array.from({ length: 8 }, () => result({})),
      result({ correct: false, matchedFactCount: 0 }),
      result({ correct: false, matchedFactCount: 0 }),
      result({
        class: 'B',
        expectedFactCount: 10,
        matchedFactCount: 10,
      }),
    ];
    expect(aggregate(cases).decision.outcome).toBe(
      'investigate_named_retrieval',
    );
  });

  test('recommends markdown when Class B recall is below 80%', () => {
    const cases = [
      result({}),
      result({
        class: 'B',
        expectedFactCount: 10,
        matchedFactCount: 7,
        correctlyCitedFactCount: 7,
      }),
    ];
    expect(aggregate(cases).decision).toMatchObject({
      outcome: 'structured_markdown_needed',
      markdownRegenerationNeeded: true,
    });
  });

  test('keeps direct PDF when both thresholds pass', () => {
    const cases = [
      result({}),
      result({
        class: 'B',
        expectedFactCount: 10,
        matchedFactCount: 8,
        correctlyCitedFactCount: 8,
      }),
    ];
    expect(aggregate(cases).decision).toMatchObject({
      outcome: 'direct_pdf_sufficient',
      markdownRegenerationNeeded: false,
    });
  });
});

test('repository selection follows the runtime NSPRA rule', () => {
  expect(
    selectRepository({
      repositories: [
        { id: 3, name: 'NSPRA archive' },
        {
          id: 9,
          name: 'NSPRA 2026 Calendar',
          visibility: 'private',
          itemCount: 1,
        },
      ],
    }),
  ).toMatchObject({ id: 9, name: 'NSPRA 2026 Calendar' });
});
