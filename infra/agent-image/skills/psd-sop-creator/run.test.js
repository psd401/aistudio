/**
 * psd-sop-creator regression tests.
 *
 * Two surfaces are covered:
 *
 *   1. The TEMPLATE GATE (`validateBody`) — pure, no IO. This is the thing that
 *      decides whether a draft is a real PSD SOP, and every rule in it exists
 *      because breaking it loses content silently in Atrium (raw HTML dropped,
 *      data: URIs stripped, inline images splitting paragraphs). A regression
 *      here ships malformed SOPs, so each rule gets its own case.
 *
 *   2. The `create` ORCHESTRATION — the composed psd-atrium calls are injected
 *      (deps.runSkill), so these assert the ORDER and ARGUMENTS of the real
 *      sequence without a network: create the object first (assets attach to an
 *      object), upload the images second (a version may only reference a `ready`
 *      asset), write the body last.
 *
 * process.exit is stubbed to throw so exit codes are observable.
 */

'use strict';

const { test, expect, beforeEach, afterEach } = require('bun:test');
const os = require('node:os');
const { validatedFs } = require('../../../validated-fs.cjs');
const path = require('node:path');

const mod = require('./run');
const { main, _internals } = mod;
const { validateBody, titleFromBody, buildDocument, collectImages, applyReplacements } =
  _internals;

const VALID_BODY = validatedFs.readFileSync(
  path.join(__dirname, 'test-fixtures', 'valid-sop.md'),
  'utf8'
);

class ExitError extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

let emitted;
let originalExit;
let originalStdoutWrite;
let originalStderrWrite;
let originalEnv;

beforeEach(() => {
  emitted = [];
  originalExit = process.exit;
  originalStdoutWrite = process.stdout.write;
  originalStderrWrite = process.stderr.write;
  originalEnv = process.env.APP_BASE_URL;
  process.env.APP_BASE_URL = 'https://aistudio.test';
  process.exit = (code) => {
    throw new ExitError(code);
  };
  process.stdout.write = (chunk) => {
    const text = String(chunk).trim();
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        emitted.push(JSON.parse(text));
      } catch {
        /* usage text, not JSON */
      }
    }
    return true;
  };
  process.stderr.write = () => true;
});

afterEach(() => {
  process.exit = originalExit;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  if (originalEnv === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = originalEnv;
});

/** Run main() with the given argv, capturing the exit code when it exits. */
function run(argv, deps) {
  let code = 0;
  try {
    main(['node', 'run.js', ...argv], deps);
  } catch (err) {
    if (!(err instanceof ExitError)) throw err;
    code = err.code;
  }
  return { code, out: emitted[emitted.length - 1] };
}

function codesOf(result) {
  return (result.out.violations || []).map((v) => v.code).sort();
}

/** Replace one `## Section` heading in the fixture, keeping everything else. */
function withBody(replacer) {
  return replacer(VALID_BODY);
}

// ── the template gate ────────────────────────────────────────────────────────

test('the transcribed template fixture validates clean', () => {
  expect(validateBody(VALID_BODY)).toEqual([]);
});

test('validate exits 0 and reports the parsed sections', () => {
  const result = run(['validate', '--body', VALID_BODY]);
  expect(result.code).toBe(0);
  expect(result.out.valid).toBe(true);
  expect(result.out.title).toBe('Printer & Copier Allocation, Upkeep & Maintenance');
  expect(result.out.sections).toEqual(_internals.REQUIRED_SECTIONS);
});

test('an empty body is a single, clear violation', () => {
  const violations = validateBody('   \n  ');
  expect(violations).toHaveLength(1);
  expect(violations[0].code).toBe('empty_body');
});

test('a missing required section is reported by name', () => {
  const body = withBody((b) => b.replace('## Quality Control', '## Notes'));
  const violations = validateBody(body);
  expect(violations.some((v) => v.code === 'missing_section' && v.section === 'Quality Control')).toBe(true);
  // A misspelled/renamed required heading ALSO surfaces as unknown, which is
  // how a typo is caught rather than silently accepted as an extra section.
  expect(violations.some((v) => v.code === 'unknown_section' && v.section === 'Notes')).toBe(true);
});

test('sections out of template order are rejected', () => {
  const body = [
    '## Title',
    'T',
    '## Procedure',
    'P',
    '## Scope',
    'S',
    '## Safety Considerations',
    'X',
    '## Quality Control',
    'X',
    '## References',
    'X',
    '## Revision History',
    'X',
  ].join('\n');
  expect(validateBody(body).some((v) => v.code === 'section_order')).toBe(true);
});

test('an optional section is allowed only in its template position', () => {
  const inPosition = withBody((b) =>
    b.replace('## Scope', '## Purpose\n\nWhy this exists.\n\n## Scope')
  );
  expect(validateBody(inPosition)).toEqual([]);

  // Purpose belongs after Title, not after References.
  const outOfPosition = withBody((b) =>
    b.replace('## Revision History', '## Purpose\n\nWhy.\n\n## Revision History')
  );
  expect(validateBody(outOfPosition).some((v) => v.code === 'section_order')).toBe(true);
});

test('a duplicated section is rejected', () => {
  const body = `${VALID_BODY}\n\n## Scope\n\nAgain\n`;
  const violations = validateBody(body);
  expect(violations.some((v) => v.code === 'duplicate_section')).toBe(true);
  // …and so is the order break it creates, which is the same underlying mistake.
  expect(violations.some((v) => v.code === 'section_order')).toBe(true);
});

test('an empty required section is rejected rather than silently shipped', () => {
  const body = withBody((b) =>
    b.replace(
      /## Safety Considerations\n\n[\s\S]*?\n\n## Quality Control/,
      '## Safety Considerations\n\n## Quality Control'
    )
  );
  const violations = validateBody(body);
  expect(
    violations.some((v) => v.code === 'empty_section' && v.section === 'Safety Considerations')
  ).toBe(true);
});

test('raw HTML is rejected because Atrium drops it without an error', () => {
  for (const snippet of ['<table><tr><td>a</td></tr></table>', 'text<br>more', '<div class="x">']) {
    const body = withBody((b) => b.replace('All schools and administrative buildings', snippet));
    expect(validateBody(body).some((v) => v.code === 'raw_html')).toBe(true);
  }
});

test('HTML inside a fenced code block is fine — it is an example, not markup', () => {
  const body = withBody((b) =>
    b.replace(
      'All schools and administrative buildings',
      'All schools\n\n```html\n<table><tr><td>example</td></tr></table>\n```'
    )
  );
  expect(validateBody(body)).toEqual([]);
});

test('a CRLF body validates the same as an LF body', () => {
  const result = run(['validate', '--body', VALID_BODY.replace(/\n/g, '\r\n')]);
  expect(result.code).toBe(0);
  expect(result.out.valid).toBe(true);
  expect(result.out.sections).toEqual(_internals.REQUIRED_SECTIONS);
});

test('a ``` line inside a ```` fence does not close it (CommonMark fence lengths)', () => {
  const body = withBody((b) =>
    b.replace(
      'All schools and administrative buildings',
      [
        'All schools and administrative buildings',
        '',
        '````',
        '```',
        '## Not A Real Section',
        '````',
      ].join('\n')
    )
  );
  expect(validateBody(body)).toEqual([]);
});

test('a reference-style image is rejected — it would bypass upload entirely', () => {
  const body = withBody((b) =>
    b.replace(
      'All schools and administrative buildings',
      'All schools\n\n![Diagram][fig1]\n\n[fig1]: ./diagram.png'
    )
  );
  const violations = validateBody(body);
  expect(violations.map((v) => v.code)).toContain('reference_image');
});

test('a heading inside a fenced code block is not counted as a section', () => {
  const body = withBody((b) =>
    b.replace(
      'All schools and administrative buildings',
      'All schools\n\n```\n## Scope\n```'
    )
  );
  // No duplicate_section: the fenced "## Scope" is sample text, not structure.
  expect(validateBody(body)).toEqual([]);
});

test('an autolinked URL is not mistaken for an HTML tag', () => {
  const body = withBody((b) =>
    b.replace('All schools and administrative buildings', 'See <https://psd401.net/print>')
  );
  expect(validateBody(body).some((v) => v.code === 'raw_html')).toBe(false);
});

test('a data: URI image is rejected because the sanitizer strips it', () => {
  const body = withBody((b) =>
    b.replace(
      'All schools and administrative buildings',
      'All schools\n\n![chart](data:image/png;base64,iVBORw0KGgo=)'
    )
  );
  expect(validateBody(body).some((v) => v.code === 'data_uri')).toBe(true);
});

test('an image sharing a line with prose is rejected; on its own line it is fine', () => {
  const inline = withBody((b) =>
    b.replace(
      'All schools and administrative buildings',
      'See the panel ![panel](/tmp/p.png) before starting.'
    )
  );
  expect(validateBody(inline).some((v) => v.code === 'inline_image')).toBe(true);

  const ownLine = withBody((b) =>
    b.replace(
      'All schools and administrative buildings',
      'All schools\n\n![panel](/tmp/p.png)'
    )
  );
  expect(validateBody(ownLine)).toEqual([]);
});

test('a body carrying its own H1 is rejected — the skill injects it', () => {
  const body = `# Standard Operating Procedure (SOP)\n\n${VALID_BODY}`;
  expect(validateBody(body).some((v) => v.code === 'injected_heading')).toBe(true);
});

test('every violation carries an actionable fix', () => {
  const body = '## Scope\n\n<div>x</div>\n';
  const violations = validateBody(body);
  expect(violations.length).toBeGreaterThan(0);
  for (const violation of violations) {
    expect(typeof violation.fix).toBe('string');
    expect(violation.fix.length).toBeGreaterThan(0);
  }
});

test('validate exits 3 with the structured violation list', () => {
  const result = run(['validate', '--body', '## Scope\n\nOnly this.\n']);
  expect(result.code).toBe(3);
  expect(result.out.status).toBe('template_violations');
  expect(result.out.count).toBe(result.out.violations.length);
  expect(codesOf(result)).toContain('missing_section');
});

// ── document assembly ────────────────────────────────────────────────────────

test('the assembled document carries the letterhead, H1, and metadata table', () => {
  const doc = buildDocument({
    body: VALID_BODY,
    owner: 'Director of Technology',
    department: 'Technology',
    effectiveDate: '2026-08-01',
    logoUrl: 'https://aistudio.test/branding/psd-logo-2color-horizontal.png',
  });
  const lines = doc.split('\n');
  // Order matters: the template puts the logo above the heading.
  expect(lines[0]).toBe(
    '![Peninsula School District](https://aistudio.test/branding/psd-logo-2color-horizontal.png)'
  );
  expect(lines[2]).toBe('# Standard Operating Procedure (SOP)');
  expect(doc).toContain('| **Owner** | Director of Technology |');
  expect(doc).toContain('| **Effective date** | 2026-08-01 |');
  expect(doc).toContain('| **Status** | Draft |');
  expect(doc).toContain('## Revision History');
  // The logo must be an ABSOLUTE url — isSafeMediaUrl rejects relative paths.
  expect(doc).not.toContain('](/branding/');
});

test('titleFromBody reads the ## Title section', () => {
  expect(titleFromBody(VALID_BODY)).toBe(
    'Printer & Copier Allocation, Upkeep & Maintenance'
  );
  expect(titleFromBody('## Scope\n\nx\n')).toBeNull();
});

test('collectImages classifies external, local, and atrium-asset references', () => {
  const body = [
    '![hosted](https://cdn.example/a.png)',
    '',
    '![local](imgs/b.png)',
    '',
    '::atrium-asset{id="asset-1" alt="Diagram"}',
  ].join('\n');
  const images = collectImages(body, '/base');
  expect(images.map((i) => i.kind)).toEqual(['external', 'local', 'asset']);
  expect(images[1].resolved).toBe(path.resolve('/base', 'imgs/b.png'));
  expect(images[2]).toMatchObject({ assetId: 'asset-1', alt: 'Diagram' });
});

test('collectImages handles a path with spaces — validate accepts it, so create must too', () => {
  const images = collectImages('![Panel](my panel.png)', '/base');
  expect(images).toHaveLength(1);
  expect(images[0]).toMatchObject({ kind: 'local', src: 'my panel.png' });
  expect(images[0].resolved).toBe(path.resolve('/base', 'my panel.png'));
});

test('a pipe in the owner value cannot corrupt the metadata table', () => {
  const doc = buildDocument({
    body: '## Title\n\nX',
    owner: 'Help Desk | IT Operations',
    department: 'Technology',
    effectiveDate: '2026-08-01',
    logoUrl: 'https://aistudio.test/branding/psd-logo.png',
  });
  expect(doc).toContain('| **Owner** | Help Desk \\| IT Operations |');
  // Still a two-column row after escaping: unescaped pipes would add columns.
  const row = doc.split('\n').find((l) => l.includes('**Owner**'));
  expect(row.split(/(?<!\\)\|/).length).toBe(4);
});

test('a backslash in the owner value cannot neutralize the pipe escaping', () => {
  const doc = buildDocument({
    body: '## Title\n\nX',
    owner: 'Ops\\| still one cell',
    department: 'Technology',
    effectiveDate: '2026-08-01',
    logoUrl: 'https://aistudio.test/branding/psd-logo.png',
  });
  // The input's backslash is escaped first, then the pipe — so the cell keeps
  // exactly two columns and the raw sequence never reaches the table syntax.
  const row = doc.split('\n').find((l) => l.includes('**Owner**'));
  expect(row).toBe('| **Owner** | Ops\\\\\\| still one cell |');
  expect(row.split(/(?<!\\)\|/).length).toBe(4);
});

test('applyReplacements swaps only the referenced lines', () => {
  const body = 'a\n![x](p.png)\nb';
  expect(applyReplacements(body, new Map([[1, '::atrium-asset{id="z" alt="x"}']]))).toBe(
    'a\n::atrium-asset{id="z" alt="x"}\nb'
  );
  expect(applyReplacements(body, new Map())).toBe(body);
});

// ── create orchestration ─────────────────────────────────────────────────────

/** A psd-atrium stub that records every invocation. */
function atriumStub(overrides = {}) {
  const calls = [];
  const runSkill = (spec) => {
    // Snapshot any file-transported body AT CALL TIME. The real psd-atrium
    // reads it during the call too, and the skill deletes its scratch
    // directory as soon as `create` returns — so reading it afterwards would
    // race the cleanup that production correctly performs.
    const capture = { ...spec, files: {} };
    for (const flag of ['--markdown-file', '--body-file']) {
      const at = spec.args.indexOf(flag);
      if (at !== -1) capture.files[flag] = validatedFs.readFileSync(spec.args[at + 1], 'utf8');
    }
    calls.push(capture);
    const sub = spec.args[0];
    if (overrides[sub]) return overrides[sub](spec);
    if (sub === 'create-document') {
      return {
        code: 0,
        stdout: JSON.stringify({
          id: 'obj-1',
          slug: 'printer-copier-allocation',
          url: '/c/printer-copier-allocation',
          visibilityLevel: 'private',
        }),
        stderr: '',
      };
    }
    if (sub === 'upload-asset') {
      // Real asset ids are UUIDs, and the directive parser requires one — a
      // stub returning "asset-1" would produce a directive that silently
      // degrades to literal text in the document.
      const n = calls.filter((c) => c.args[0] === 'upload-asset').length;
      const id = `2f1c9d0e-7a3b-4c5d-9e6f-00000000000${n}`;
      return {
        code: 0,
        stdout: JSON.stringify({
          id,
          state: 'ready',
          directive: `::atrium-asset{id="${id}" alt="Control panel"}`,
        }),
        stderr: '',
      };
    }
    if (sub === 'get-asset') {
      const out = spec.args[spec.args.indexOf('--out') + 1];
      validatedFs.writeFileSync(out, Buffer.from([0x89, 0x50, 0x4E, 0x47]));
      return { code: 0, stdout: JSON.stringify({ id: 'src-asset', path: out }), stderr: '' };
    }
    return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
  };
  return { calls, runSkill };
}

const CREATE_META = [
  '--owner',
  'Director of Technology',
  '--department',
  'Technology',
  '--effective-date',
  '2026-08-01',
];

test('create with no images posts the whole document in one call', () => {
  const { calls, runSkill } = atriumStub();
  const result = run(['create', '--body', VALID_BODY, ...CREATE_META], { runSkill });

  expect(result.code).toBe(0);
  expect(calls).toHaveLength(1);
  const args = calls[0].args;
  expect(args[0]).toBe('create-document');
  expect(args[args.indexOf('--title') + 1]).toBe(
    'Printer & Copier Allocation, Upkeep & Maintenance'
  );
  // Private + the SOP collection, never inherited from a flag default elsewhere.
  expect(args[args.indexOf('--visibility') + 1]).toBe('private');
  expect(args[args.indexOf('--collection') + 1]).toBe('standard-operating-procedures');
  // The body goes through a FILE, always — a whole SOP can exceed the 128 KiB
  // per-argument limit and fail the spawn with E2BIG. Passing it inline only
  // when it happens to be small would leave the large-document path untested.
  expect(args).not.toContain('--markdown');
  const markdown = calls[0].files['--markdown-file'];
  expect(markdown).toContain('# Standard Operating Procedure (SOP)');
  expect(markdown).toContain('| **Owner** | Director of Technology |');

  expect(result.out.status).toBe('ok');
  expect(result.out.documentStatus).toBe('draft');
  expect(result.out.visibility).toBe('private');
  expect(result.out.url).toBe('https://aistudio.test/c/printer-copier-allocation');
  expect(result.out.message).toMatch(/private draft/i);
});

test('create with a local image creates the object FIRST, uploads, then writes the body', () => {
  const dir = validatedFs.mkdtempSync(path.join(os.tmpdir(), 'sop-img-'));
  validatedFs.writeFileSync(path.join(dir, 'panel.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));
  const body = VALID_BODY.replace(
    'All schools and administrative buildings',
    'All schools and administrative buildings\n\n![Control panel](panel.png)'
  );
  const { calls, runSkill } = atriumStub();

  const result = run(
    ['create', '--body', body, ...CREATE_META, '--image-base', dir],
    { runSkill }
  );

  expect(result.code).toBe(0);
  // The ordering is forced by the platform, not a preference: an asset attaches
  // to an OBJECT, and a version may only reference a `ready` asset.
  expect(calls.map((c) => c.args[0])).toEqual([
    'create-document',
    'upload-asset',
    'edit',
  ]);

  // The bodyless create avoids writing a body that would immediately be replaced.
  expect(calls[0].args).not.toContain('--markdown');
  expect(calls[0].args).not.toContain('--markdown-file');
  expect(calls[1].args[calls[1].args.indexOf('--alt') + 1]).toBe('Control panel');
  expect(calls[1].args[calls[1].args.indexOf('--file') + 1]).toBe(
    path.join(dir, 'panel.png')
  );

  const finalBody = calls[2].files['--body-file'];
  expect(finalBody).toContain(
    '::atrium-asset{id="2f1c9d0e-7a3b-4c5d-9e6f-000000000001" alt="Control panel"}'
  );
  expect(finalBody).not.toContain('![Control panel](panel.png)');
  expect(result.out.images.uploaded).toBe(1);
});

test('create copies an ::atrium-asset image out of --source-id', () => {
  const body = VALID_BODY.replace(
    'All schools and administrative buildings',
    'All schools and administrative buildings\n\n::atrium-asset{id="src-asset-9" alt="Diagram"}'
  );
  const { calls, runSkill } = atriumStub();

  const result = run(
    ['create', '--body', body, ...CREATE_META, '--source-id', 'obj-source'],
    { runSkill }
  );

  expect(result.code).toBe(0);
  expect(calls.map((c) => c.args[0])).toEqual([
    'create-document',
    'get-asset',
    'upload-asset',
    'edit',
  ]);
  const getArgs = calls[1].args;
  expect(getArgs[getArgs.indexOf('--id') + 1]).toBe('obj-source');
  expect(getArgs[getArgs.indexOf('--asset-id') + 1]).toBe('src-asset-9');
  // Re-uploaded under a NEW id: an asset belongs to exactly one object.
  const finalBody = calls[3].files['--body-file'];
  expect(finalBody).toContain('::atrium-asset{id="2f1c9d0e-7a3b-4c5d-9e6f-000000000001"');
  expect(finalBody).not.toContain('src-asset-9');
});

test('create refuses an ::atrium-asset reference with no --source-id', () => {
  const body = VALID_BODY.replace(
    'All schools and administrative buildings',
    'All schools\n\n::atrium-asset{id="src-asset-9" alt="Diagram"}'
  );
  const { runSkill } = atriumStub();
  const result = run(['create', '--body', body, ...CREATE_META], { runSkill });
  expect(result.code).toBe(1);
  expect(result.out.error).toBe('source_id_required');
});

test('create leaves an external https image untouched', () => {
  const body = VALID_BODY.replace(
    'All schools and administrative buildings',
    'All schools\n\n![Hosted](https://cdn.example/a.png)'
  );
  const { calls, runSkill } = atriumStub();
  const result = run(['create', '--body', body, ...CREATE_META], { runSkill });

  expect(result.code).toBe(0);
  expect(calls.map((c) => c.args[0])).toEqual(['create-document']);
  expect(result.out.images).toMatchObject({ uploaded: 0, external: 1 });
});

test('create validates BEFORE touching Atrium, so a bad draft leaves no stray document', () => {
  const { calls, runSkill } = atriumStub();
  const result = run(['create', '--body', '## Scope\n\nOnly this.\n', ...CREATE_META], {
    runSkill,
  });
  expect(result.code).toBe(3);
  expect(calls).toHaveLength(0);
});

test('create rejects an unknown department and a malformed effective date', () => {
  const { runSkill } = atriumStub();
  expect(
    run(
      [
        'create',
        '--body',
        VALID_BODY,
        '--owner',
        'X',
        '--department',
        'Rocketry',
        '--effective-date',
        '2026-08-01',
      ],
      { runSkill }
    ).code
  ).toBe(1);
  expect(
    run(
      [
        'create',
        '--body',
        VALID_BODY,
        '--owner',
        'X',
        '--department',
        'Technology',
        '--effective-date',
        'August 2026',
      ],
      { runSkill }
    ).code
  ).toBe(1);
});

test('create requires owner, department, and effective date', () => {
  const { runSkill } = atriumStub();
  for (const partial of [
    ['--department', 'Technology', '--effective-date', '2026-08-01'],
    ['--owner', 'X', '--effective-date', '2026-08-01'],
    ['--owner', 'X', '--department', 'Technology'],
  ]) {
    expect(run(['create', '--body', VALID_BODY, ...partial], { runSkill }).code).toBe(1);
  }
});

test('create refuses when APP_BASE_URL is unset — a relative logo would be dropped', () => {
  delete process.env.APP_BASE_URL;
  const { calls, runSkill } = atriumStub();
  const result = run(['create', '--body', VALID_BODY, ...CREATE_META], { runSkill });
  expect(result.code).toBe(1);
  expect(result.out.error).toBe('misconfigured');
  expect(calls).toHaveLength(0);
});

test('create names a missing image file instead of creating a broken document', () => {
  const body = VALID_BODY.replace(
    'All schools and administrative buildings',
    'All schools\n\n![Panel](does-not-exist.png)'
  );
  const { runSkill } = atriumStub();
  const result = run(['create', '--body', body, ...CREATE_META, '--image-base', os.tmpdir()], {
    runSkill,
  });
  expect(result.code).toBe(1);
  expect(result.out.error).toBe('image_missing');
  expect(result.out.message).toContain('does-not-exist.png');
});

test('an upstream psd-atrium failure surfaces as exit 12', () => {
  const { runSkill } = atriumStub({
    'create-document': () => ({
      code: 12,
      stdout: JSON.stringify({ status: 'error', message: 'Collection not found' }),
      stderr: '',
    }),
  });
  const result = run(['create', '--body', VALID_BODY, ...CREATE_META], { runSkill });
  expect(result.code).toBe(12);
  expect(result.out.message).toContain('Collection not found');
});

test('--body-file and --body are mutually exclusive', () => {
  // mkdtempSync, not tmpdir()+Date.now(): a predictable path in the shared temp
  // dir is pre-creatable by a local actor and collides between same-millisecond
  // runs. Same reason the skill itself uses mkdtempSync for its scratch dir.
  const file = path.join(
    validatedFs.mkdtempSync(path.join(os.tmpdir(), 'psd-sop-body-')),
    'sop.md'
  );
  validatedFs.writeFileSync(file, VALID_BODY);
  expect(run(['validate', '--body-file', file]).code).toBe(0);
  expect(run(['validate', '--body-file', file, '--body', VALID_BODY]).code).toBe(1);
});

test('an unknown subcommand exits 1', () => {
  expect(run(['publish', '--id', 'x']).code).toBe(1);
});

test('a non-UUID asset id is rejected — the directive would render as literal text', () => {
  const dir = validatedFs.mkdtempSync(path.join(os.tmpdir(), 'sop-uuid-'));
  validatedFs.writeFileSync(path.join(dir, 'panel.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));
  const body = VALID_BODY.replace(
    'All schools and administrative buildings',
    'All schools\n\n![Panel](panel.png)'
  );
  const { runSkill } = atriumStub({
    'upload-asset': () => ({
      code: 0,
      stdout: JSON.stringify({
        id: 'asset-1',
        directive: '::atrium-asset{id="asset-1" alt="Panel"}',
      }),
      stderr: '',
    }),
  });
  const result = run(['create', '--body', body, ...CREATE_META, '--image-base', dir], {
    runSkill,
  });
  expect(result.code).toBe(12);
  expect(result.out.message).toMatch(/no UUID/i);
});

// ── review-driven regressions ────────────────────────────────────────────────

test('image syntax inside a fenced code block is NOT treated as a real image', () => {
  // A technical SOP legitimately documents markdown. Scanning raw lines would
  // try to upload the EXAMPLE — failing on a path that never existed, or worse,
  // uploading something and rewriting the example into a live directive.
  const body = [
    '![real](/tmp/real.png)',
    '',
    '```markdown',
    '![example](imgs/not-real.png)',
    '::atrium-asset{id="11111111-1111-4111-8111-111111111111" alt="sample"}',
    '```',
  ].join('\n');
  const images = collectImages(body, '/base');
  expect(images).toHaveLength(1);
  expect(images[0].src).toBe('/tmp/real.png');
});

test('create validates image files BEFORE creating anything in Atrium', () => {
  const body = VALID_BODY.replace(
    'All schools and administrative buildings',
    'All schools\n\n![Panel](missing.png)'
  );
  const { calls, runSkill } = atriumStub();
  const result = run(
    ['create', '--body', body, ...CREATE_META, '--image-base', os.tmpdir()],
    { runSkill }
  );

  expect(result.code).toBe(1);
  expect(result.out.error).toBe('image_missing');
  // The whole point: a typo'd path must not leave an empty private draft that
  // multiplies on every retry.
  expect(calls).toHaveLength(0);
  expect(result.out.message).toContain('Nothing was created in Atrium');
});

test('create refuses a missing --source-id before creating anything', () => {
  const body = VALID_BODY.replace(
    'All schools and administrative buildings',
    'All schools\n\n::atrium-asset{id="11111111-1111-4111-8111-111111111111" alt="D"}'
  );
  const { calls, runSkill } = atriumStub();
  const result = run(['create', '--body', body, ...CREATE_META], { runSkill });

  expect(result.code).toBe(1);
  expect(result.out.error).toBe('source_id_required');
  expect(calls).toHaveLength(0);
});

test('a failed upload discards the document it already created', () => {
  const dir = validatedFs.mkdtempSync(path.join(os.tmpdir(), 'sop-fail-'));
  validatedFs.writeFileSync(path.join(dir, 'panel.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));
  const body = VALID_BODY.replace(
    'All schools and administrative buildings',
    'All schools\n\n![Panel](panel.png)'
  );
  const { calls, runSkill } = atriumStub({
    'upload-asset': () => ({
      code: 12,
      stdout: JSON.stringify({ status: 'error', message: 'storage unavailable' }),
      stderr: '',
    }),
  });

  const result = run(['create', '--body', body, ...CREATE_META, '--image-base', dir], {
    runSkill,
  });

  expect(result.code).toBe(12);
  expect(result.out.message).toContain('storage unavailable');
  // The object EXISTS by this point, so it has to be cleaned up — otherwise
  // every retry of a transient storage failure leaves another empty draft.
  expect(calls.map((c) => c.args[0])).toEqual([
    'create-document',
    'upload-asset',
    'delete',
  ]);
  expect(calls[2].args[calls[2].args.indexOf('--id') + 1]).toBe('obj-1');
  // The payload must also SAY what happened, or the caller cannot reason
  // about whether a retry is safe.
  expect(result.out.documentId).toBe('obj-1');
  expect(result.out.cleanup).toBe('discarded');
});

test('a failed cleanup is reported so the caller can delete the orphan by id', () => {
  const dir = validatedFs.mkdtempSync(path.join(os.tmpdir(), 'sop-fail2-'));
  validatedFs.writeFileSync(path.join(dir, 'panel.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47]));
  const body = VALID_BODY.replace(
    'All schools and administrative buildings',
    'All schools\n\n![Panel](panel.png)'
  );
  const { runSkill } = atriumStub({
    'upload-asset': () => ({
      code: 12,
      stdout: JSON.stringify({ status: 'error', message: 'storage unavailable' }),
      stderr: '',
    }),
    delete: () => ({
      code: 12,
      stdout: JSON.stringify({ status: 'error', message: 'delete also failed' }),
      stderr: '',
    }),
  });

  const result = run(['create', '--body', body, ...CREATE_META, '--image-base', dir], {
    runSkill,
  });

  expect(result.code).toBe(12);
  expect(result.out.message).toContain('storage unavailable');
  expect(result.out.documentId).toBe('obj-1');
  expect(result.out.cleanup).toBe('delete_failed');
});
