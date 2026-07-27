#!/usr/bin/env node
/**
 * run.js — psd-sop-creator skill entrypoint.
 *
 * Turns a drafted procedure into a Peninsula School District Standard Operating
 * Procedure, filed in Atrium as an EDITABLE DOCUMENT (kind=document, markdown) —
 * not a rendered HTML artifact. An SOP is a living document that staff revise;
 * an artifact would be a snapshot nobody can edit.
 *
 * It COMPOSES existing agent-image skills rather than re-implementing them:
 *   Atrium read/write + images → psd-atrium (read-source, upload-asset, get-asset,
 *                                create-document, edit)
 *   PDF ingest                 → psd-pdf-to-markdown (--extract-images)
 *   Google Docs ingest         → psd-workspace
 *
 * Subcommands:
 *   validate  — structural gate only, no network. Use it while drafting.
 *   create    — validate, then create the Atrium document.
 *
 * The document `create` produces is PRIVATE and in DRAFT status. Review and
 * publication are deliberately a human step; there is no approval workflow here.
 *
 * Exit codes (the cross-skill contract):
 *   0   success (JSON on stdout)
 *   1   usage / bad arguments
 *   2   internal / unexpected
 *   3   TEMPLATE VIOLATIONS — a structured list. This is the actionable one:
 *       fix the body and retry. Never a reason to give up on the SOP.
 *   12  upstream failure (Atrium, PDF conversion, storage)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Container layout (overridable so the unit tests can point at fakes).
const SKILLS_DIR = process.env.PSD_SKILLS_DIR || '/opt/psd-skills';
const VENV_PY = process.env.PSD_VENV_PYTHON || '/opt/agentcore-venv/bin/python3';
/** Read at CALL time, not module-load time, so a test (or a wrapper that sets it
 *  late) is not fixed to whatever the environment held when this file was first
 *  required. */
function appBaseUrl() {
  return (process.env.APP_BASE_URL || '').replace(/\/+$/, '');
}

/** The Atrium collection every SOP is filed into (seeded by migration 161). */
const DEFAULT_COLLECTION = 'standard-operating-procedures';

/** Path of the hosted district logo, relative to APP_BASE_URL. */
const LOGO_PATH = '/branding/psd-logo-2color-horizontal.png';
const LOGO_ALT = 'Peninsula School District';

const H1 = '# Standard Operating Procedure (SOP)';

const REQUIRED_SECTIONS = [
  'Title',
  'Scope',
  'Procedure',
  'Safety Considerations',
  'Quality Control',
  'References',
  'Revision History',
];

/**
 * Every legal heading, in the ONLY order they may appear. Validation asserts the
 * body's headings are a SUBSEQUENCE of this list, which enforces the required
 * order and each optional section's insert position in one check — rather than
 * two rule sets that can disagree.
 */
const CANONICAL_ORDER = [
  'Title',
  'Purpose',
  'Scope',
  'Definitions',
  'Procedure',
  'Compliance',
  'Safety Considerations',
  'Quality Control',
  'Contact',
  'References',
  'Revision History',
  'Addendum',
  'Glossary',
];

const DEPARTMENTS = [
  'Athletics & Activities',
  'Teaching and Learning',
  'Employee Support Services',
  'Communications and Public Relations',
  'Safety and Security',
  'Finance and Operations',
  'Technology',
  'Governance and Leadership',
];

// ── output contract ──────────────────────────────────────────────────────────

function fail(message, code = 'bad_args', exit = 1) {
  process.stderr.write(`psd-sop-creator: ${message}\n`);
  process.stdout.write(JSON.stringify({ status: 'error', error: code, message }) + '\n');
  process.exit(exit);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

/**
 * Exit 3 with the full violation list. Deliberately NOT a hard failure in tone:
 * the caller is expected to fix the body and call again, so every violation
 * carries a `fix` telling it what to change.
 */
function emitViolations(violations) {
  emit({
    status: 'template_violations',
    error: 'template_violations',
    count: violations.length,
    violations,
    message:
      'The draft does not match the PSD Standard Operations Template. Fix every ' +
      'violation below and run again. See references/template.md for the exact skeleton.',
  });
  process.exit(3);
}

// ── args ─────────────────────────────────────────────────────────────────────

function parseArgs(argv, startIndex) {
  const args = {};
  for (let i = startIndex; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) fail(`Unexpected positional argument: ${arg}`);
    const key = arg.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function requireStr(args, name, label) {
  const v = args[name];
  if (v === undefined || v === true || v === '') fail(`--${label} is required`);
  return v;
}

function optStr(args, name, label) {
  const v = args[name];
  if (v === undefined) return undefined;
  if (v === true) fail(`--${label} requires a value`);
  return v;
}

function usage() {
  process.stdout.write(
    [
      'Usage: node run.js <subcommand> [flags]',
      '',
      'validate  — structural gate only; no network. Run this while drafting.',
      '  node run.js validate (--body <md> | --body-file <path>)',
      '',
      'create    — validate, then create the Atrium document (PRIVATE, DRAFT).',
      '  node run.js create (--body <md> | --body-file <path>)',
      '                     --owner <name-or-role> --department <dept>',
      '                     --effective-date <YYYY-MM-DD>',
      '                     [--title <t>]           (default: the ## Title section)',
      '                     [--collection <slug>]   (default: standard-operating-procedures)',
      '                     [--tags a,b]',
      '                     [--image-base <dir>]    (resolves relative image paths)',
      '                     [--source-id <atriumId>] (copy ::atrium-asset images from here)',
      '',
      `Departments: ${DEPARTMENTS.join(' | ')}`,
      '',
    ].join('\n')
  );
}

// ── markdown structure ───────────────────────────────────────────────────────

/**
 * Split the body into lines tagged with whether they sit inside a fenced code
 * block. Every structural check runs off this, so a ``` example containing an
 * HTML tag or a `## Heading` is never mistaken for real structure.
 */
function scanLines(markdown) {
  const out = [];
  let fence = null;
  for (const [index, text] of String(markdown).split('\n').entries()) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(text);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) {
        fence = marker;
        out.push({ index, text, inCode: true });
        continue;
      }
      if (fence === marker) {
        fence = null;
        out.push({ index, text, inCode: true });
        continue;
      }
    }
    out.push({ index, text, inCode: fence !== null });
  }
  return out;
}

/** Ordered `## Heading` list (outside code fences), with their line numbers. */
function collectHeadings(lines) {
  const headings = [];
  for (const line of lines) {
    if (line.inCode) continue;
    const match = /^##[ \t]+(.+?)[ \t]*:?[ \t]*$/.exec(line.text);
    if (match) headings.push({ name: match[1].trim(), line: line.index + 1 });
  }
  return headings;
}

/** Text between a heading and the next `##`, trimmed. */
function sectionBody(lines, headings, position) {
  const start = headings[position].line;
  const end =
    position + 1 < headings.length ? headings[position + 1].line - 1 : lines.length;
  return lines
    .slice(start, end)
    .map((l) => l.text)
    .join('\n')
    .trim();
}

/**
 * Structural gate. Returns a violation list (empty = valid). Pure — no IO — so
 * `validate` and `create` cannot drift apart.
 */
function validateBody(markdown) {
  const violations = [];
  const add = (code, message, fix, extra = {}) =>
    violations.push({ code, message, fix, ...extra });

  const text = String(markdown || '');
  if (!text.trim()) {
    add(
      'empty_body',
      'The body is empty.',
      'Write the SOP body starting at "## Title". See references/template.md.'
    );
    return violations;
  }

  const lines = scanLines(text);

  // The skill injects the logo, the H1, and the metadata block. A body that
  // brings its own would render them twice.
  for (const line of lines) {
    if (line.inCode) continue;
    if (/^#[ \t]+/.test(line.text)) {
      add(
        'injected_heading',
        `Line ${line.index + 1} is a level-1 heading. The skill injects "${H1}" itself.`,
        'Remove the H1 from your body; start at "## Title".',
        { line: line.index + 1 }
      );
      break;
    }
  }

  // Raw HTML is DROPPED by the editor-seeding path (markdown-bridge overrides
  // marked's `html` renderer), so it would vanish with no error at all. Refusing
  // it here is the only place the author finds out.
  for (const line of lines) {
    if (line.inCode) continue;
    const tag = /<\/?[a-zA-Z][a-zA-Z0-9-]*(?:[ \t][^>]*)?\/?>/.exec(line.text);
    if (tag) {
      add(
        'raw_html',
        `Line ${line.index + 1} contains raw HTML (${tag[0]}). Atrium drops raw HTML silently — it will not render.`,
        'Rewrite it as markdown. Pipe tables, headings, lists, bold, and links all work.',
        { line: line.index + 1 }
      );
      break;
    }
  }

  // `data:` URIs are stripped by the sanitizer, so the image would disappear.
  for (const line of lines) {
    if (line.inCode) continue;
    if (/!\[[^\]]*\]\(\s*data:/i.test(line.text)) {
      add(
        'data_uri',
        `Line ${line.index + 1} embeds an image as a data: URI. Those are stripped.`,
        'Save the image to a file and reference its path, or use an https URL.',
        { line: line.index + 1 }
      );
      break;
    }
  }

  // An image sharing a line with prose SPLITS that paragraph into three blocks,
  // cutting the sentence in half around the picture.
  for (const line of lines) {
    if (line.inCode) continue;
    if (!/!\[[^\]]*\]\([^)]*\)/.test(line.text)) continue;
    if (!/^\s*!\[[^\]]*\]\([^)]*\)\s*$/.test(line.text)) {
      add(
        'inline_image',
        `Line ${line.index + 1} has an image inside a line of prose. That splits the paragraph around the image and breaks the sentence.`,
        'Put the image on a line of its own, with blank lines around it.',
        { line: line.index + 1 }
      );
      break;
    }
  }

  const headings = collectHeadings(lines);
  const names = headings.map((h) => h.name);

  for (const heading of headings) {
    if (!CANONICAL_ORDER.includes(heading.name)) {
      add(
        'unknown_section',
        `"## ${heading.name}" (line ${heading.line}) is not a PSD SOP section.`,
        `Use one of: ${CANONICAL_ORDER.join(', ')}. A misspelled required heading shows up here.`,
        { section: heading.name, line: heading.line }
      );
    }
  }

  const seen = new Set();
  for (const heading of headings) {
    if (seen.has(heading.name)) {
      add(
        'duplicate_section',
        `"## ${heading.name}" appears more than once (line ${heading.line}).`,
        'Merge the duplicate sections into one.',
        { section: heading.name, line: heading.line }
      );
    }
    seen.add(heading.name);
  }

  for (const required of REQUIRED_SECTIONS) {
    if (!names.includes(required)) {
      add(
        'missing_section',
        `Required section "## ${required}" is missing.`,
        `Add "## ${required}" in its template position. Write N/A only if it genuinely does not apply.`,
        { section: required }
      );
    }
  }

  // Order: the heading sequence must be a subsequence of CANONICAL_ORDER.
  let cursor = -1;
  for (const heading of headings) {
    const rank = CANONICAL_ORDER.indexOf(heading.name);
    if (rank === -1) continue; // already reported as unknown
    if (rank <= cursor) {
      add(
        'section_order',
        `"## ${heading.name}" (line ${heading.line}) is out of order.`,
        `Sections must appear in this order: ${CANONICAL_ORDER.join(' → ')}.`,
        { section: heading.name, line: heading.line }
      );
      break;
    }
    cursor = rank;
  }

  for (const [position, heading] of headings.entries()) {
    if (!REQUIRED_SECTIONS.includes(heading.name)) continue;
    if (!sectionBody(lines, headings, position)) {
      add(
        'empty_section',
        `Required section "## ${heading.name}" has no content.`,
        'Write the section. If it truly does not apply, write "N/A" — but for Safety Considerations that is rarely true.',
        { section: heading.name, line: heading.line }
      );
    }
  }

  return violations;
}

/** The `## Title` section's text, or null. Used when --title is not given. */
function titleFromBody(markdown) {
  const lines = scanLines(markdown);
  const headings = collectHeadings(lines);
  const position = headings.findIndex((h) => h.name === 'Title');
  if (position === -1) return null;
  const body = sectionBody(lines, headings, position);
  const firstLine = body.split('\n').find((l) => l.trim());
  return firstLine ? firstLine.trim() : null;
}

// ── document assembly ────────────────────────────────────────────────────────

/**
 * Prepend the template's masthead: the district logo, the H1, and the metadata
 * block. The logo has to be an ABSOLUTE https URL — `isSafeMediaUrl` rejects
 * every relative path except the asset-bytes route, so a bare "/branding/…"
 * would be dropped and the SOP would silently lose its letterhead.
 *
 * The metadata block is a markdown pipe table, verified to survive the TipTap
 * collab schema (TableKit is in the shared extension set).
 */
function buildDocument({ body, owner, department, effectiveDate, logoUrl }) {
  return [
    `![${LOGO_ALT}](${logoUrl})`,
    '',
    H1,
    '',
    '| Field | Value |',
    '| --- | --- |',
    `| **Owner** | ${owner} |`,
    `| **Department** | ${department} |`,
    `| **Effective date** | ${effectiveDate} |`,
    `| **Status** | Draft |`,
    '',
    String(body).trim(),
    '',
  ].join('\n');
}

function logoUrlFrom(baseUrl) {
  if (!baseUrl) {
    fail(
      'APP_BASE_URL is not set, so the district logo has no absolute URL. ' +
        'Atrium drops relative image paths, which would leave the SOP without its letterhead.',
      'misconfigured'
    );
  }
  return `${baseUrl}${LOGO_PATH}`;
}

// ── composed-skill runner (tests inject deps.runSkill) ────────────────────────

function runSkill(spec) {
  const map = {
    atrium: { cmd: 'node', base: [path.join(SKILLS_DIR, 'psd-atrium', 'run.js')] },
    pdf: {
      cmd: VENV_PY,
      base: [path.join(SKILLS_DIR, 'psd-pdf-to-markdown', 'scripts', 'convert.py')],
    },
    workspace: { cmd: 'node', base: [path.join(SKILLS_DIR, 'psd-workspace', 'run.js')] },
  };
  const entry = map[spec.skill];
  if (!entry) throw new Error(`unknown skill: ${spec.skill}`);
  const res = spawnSync(entry.cmd, [...entry.base, ...spec.args], {
    input: spec.input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) return { code: 1, stdout: '', stderr: res.error.message };
  return {
    code: res.status == null ? 1 : res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

/**
 * The JSON a composed skill printed on stdout, or null. Whole-string parse is
 * the normal path; the suffix scan tolerates a log line printed before the JSON
 * block (single- or multi-line).
 */
function lastJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const candidate = lines.slice(i).join('\n').trim();
    if (!candidate || (candidate[0] !== '{' && candidate[0] !== '[')) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

/** Run psd-atrium and return its parsed JSON, failing loudly on a bad exit. */
function atrium(run, args, context) {
  const res = run({ skill: 'atrium', args });
  const out = lastJson(res.stdout);
  if (res.code !== 0 || !out) {
    const detail = (out && out.message) || res.stderr.trim() || `exit ${res.code}`;
    fail(`${context} failed: ${detail}`, 'atrium_failed', 12);
  }
  return out;
}

// ── images ───────────────────────────────────────────────────────────────────

const ATRIUM_ASSET_RE = /^\s*::atrium-asset\{([^}]*)\}\s*$/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const OWN_LINE_IMAGE_RE = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;

/**
 * Every image reference in the body, in document order. Three kinds:
 *   external — an http(s) URL; kept verbatim, nothing to upload.
 *   local    — a file path; uploaded to the new object as an asset.
 *   asset    — an existing ::atrium-asset directive; the bytes must be COPIED
 *              from the source object, because an asset belongs to exactly one
 *              object and a version referencing a foreign asset is rejected.
 */
function collectImages(markdown, imageBase) {
  const images = [];
  for (const [index, text] of String(markdown).split('\n').entries()) {
    const directive = ATRIUM_ASSET_RE.exec(text);
    if (directive) {
      const id = /id="([^"]+)"/.exec(directive[1]);
      const alt = /alt="([^"]*)"/.exec(directive[1]);
      images.push({
        kind: 'asset',
        line: index,
        raw: text,
        assetId: id ? id[1] : null,
        alt: alt ? alt[1] : '',
      });
      continue;
    }
    const image = OWN_LINE_IMAGE_RE.exec(text);
    if (!image) continue;
    const [, alt, src] = image;
    if (/^https?:\/\//i.test(src)) {
      images.push({ kind: 'external', line: index, raw: text, alt, src });
    } else {
      images.push({
        kind: 'local',
        line: index,
        raw: text,
        alt,
        src,
        resolved: path.resolve(imageBase, src),
      });
    }
  }
  return images;
}

/**
 * Upload every image that needs uploading and return a line-index → replacement
 * map. Ordering is forced by the platform: the object must exist before an asset
 * can attach to it, and the asset must be `ready` before a version may reference
 * it — which is why `create` makes the document FIRST and writes the body second.
 */
function materializeImages({ images, objectId, sourceId, run, scratchDir }) {
  const replacements = new Map();
  const uploaded = [];

  for (const image of images) {
    if (image.kind === 'external') continue;

    let filePath;
    if (image.kind === 'local') {
      if (!fs.existsSync(image.resolved)) {
        fail(
          `image not found: ${image.src} (resolved to ${image.resolved}). ` +
            'Pass --image-base if the paths are relative to another directory.',
          'image_missing'
        );
      }
      filePath = image.resolved;
    } else {
      if (!sourceId) {
        fail(
          `the body references ::atrium-asset{id="${image.assetId}"}, an image owned by another ` +
            'Atrium object. Pass --source-id <that object> so its bytes can be copied — an asset ' +
            'cannot be referenced across objects.',
          'source_id_required'
        );
      }
      if (!image.assetId) {
        fail('an ::atrium-asset directive in the body has no id="…"', 'bad_directive');
      }
      filePath = path.join(scratchDir, `${image.assetId}.png`);
      atrium(
        run,
        ['get-asset', '--id', sourceId, '--asset-id', image.assetId, '--out', filePath],
        `copying image ${image.assetId} from ${sourceId}`
      );
    }

    const result = atrium(
      run,
      [
        'upload-asset',
        '--id',
        objectId,
        '--file',
        filePath,
        '--alt',
        image.alt || '',
        '--purpose',
        'document_image',
      ],
      `uploading image ${path.basename(filePath)}`
    );
    if (!result.directive) {
      fail(`psd-atrium returned no embed directive for ${filePath}`, 'atrium_failed', 12);
    }
    // The directive parser (`parseContentAssetDirectiveAttrs`) requires a UUID.
    // A directive carrying anything else does not fail — it degrades into an
    // inert PARAGRAPH of literal directive text in the document, which looks
    // like a rendering bug to whoever opens it. Catch it here instead.
    if (!UUID_RE.test(result.directive)) {
      fail(
        `psd-atrium returned an embed directive with no UUID (${result.directive}); ` +
          'it would render as literal text instead of an image.',
        'atrium_failed',
        12
      );
    }
    replacements.set(image.line, result.directive);
    uploaded.push({ assetId: result.id, alt: image.alt || '', from: image.src || image.assetId });
  }

  return { replacements, uploaded };
}

function applyReplacements(markdown, replacements) {
  if (replacements.size === 0) return markdown;
  return String(markdown)
    .split('\n')
    .map((text, index) => (replacements.has(index) ? replacements.get(index) : text))
    .join('\n');
}

// ── subcommands ──────────────────────────────────────────────────────────────

function readBody(args) {
  if (args.body_file !== undefined) {
    if (args.body !== undefined) fail('pass either --body or --body-file, not both');
    const file = requireStr(args, 'body_file', 'body-file');
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (err) {
      fail(`--body-file not readable: ${err.message}`);
    }
  }
  return requireStr(args, 'body', 'body');
}

function cmdValidate(args) {
  const body = readBody(args);
  const violations = validateBody(body);
  if (violations.length) emitViolations(violations);
  emit({
    status: 'ok',
    valid: true,
    title: titleFromBody(body),
    sections: collectHeadings(scanLines(body)).map((h) => h.name),
    message: 'The draft matches the PSD Standard Operations Template.',
  });
}

function cmdCreate(args, deps = {}) {
  const run = deps.runSkill || runSkill;
  const body = readBody(args);

  const owner = requireStr(args, 'owner', 'owner');
  const department = requireStr(args, 'department', 'department');
  const effectiveDate = requireStr(args, 'effective_date', 'effective-date');
  if (!DEPARTMENTS.includes(department)) {
    fail(`--department must be one of: ${DEPARTMENTS.join(' | ')}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
    fail('--effective-date must be YYYY-MM-DD');
  }

  // Structure is checked BEFORE anything is created, so a rejected draft never
  // leaves a stray empty document behind in Atrium.
  const violations = validateBody(body);
  if (violations.length) emitViolations(violations);

  const title = optStr(args, 'title', 'title') || titleFromBody(body);
  if (!title) {
    fail('could not determine a title — pass --title or put it under "## Title"');
  }

  const logoUrl = logoUrlFrom(appBaseUrl());
  const collection = optStr(args, 'collection', 'collection') || DEFAULT_COLLECTION;
  const tags = optStr(args, 'tags', 'tags');
  const imageBase = optStr(args, 'image_base', 'image-base') || process.cwd();
  const sourceId = optStr(args, 'source_id', 'source-id');

  const images = collectImages(body, imageBase);
  const needsUpload = images.some((image) => image.kind !== 'external');

  // Step 1 — create the document. Bodyless on purpose when there are images to
  // upload: assets attach to an OBJECT, so the object has to exist first, and a
  // body written now would have to be rewritten anyway once the asset ids exist.
  const createArgs = [
    'create-document',
    '--title',
    title,
    '--collection',
    collection,
    '--visibility',
    'private',
  ];
  if (tags) createArgs.push('--tags', tags);
  if (!needsUpload) {
    createArgs.push('--markdown', buildDocument({ body, owner, department, effectiveDate, logoUrl }));
  }
  const created = atrium(run, createArgs, 'creating the Atrium document');
  if (!created.id) {
    fail('Atrium returned no document id', 'atrium_failed', 12);
  }

  // Step 2 — upload the images, then step 3 — write the body that references them.
  let uploaded = [];
  if (needsUpload) {
    const scratchDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'psd-sop-'));
    let replacements;
    try {
      ({ replacements, uploaded } = materializeImages({
        images,
        objectId: created.id,
        sourceId,
        run,
        scratchDir,
      }));
    } finally {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
    const finalBody = buildDocument({
      body: applyReplacements(body, replacements),
      owner,
      department,
      effectiveDate,
      logoUrl,
    });
    atrium(
      run,
      [
        'edit',
        '--id',
        created.id,
        '--body',
        finalBody,
        '--body-format',
        'markdown',
        '--summary',
        'Initial SOP draft',
      ],
      'writing the SOP body'
    );
  }

  const url = created.url ? `${appBaseUrl()}${created.url}` : null;
  emit({
    status: 'ok',
    id: created.id,
    slug: created.slug,
    title,
    collection,
    visibility: created.visibilityLevel || 'private',
    documentStatus: 'draft',
    owner,
    department,
    effectiveDate,
    images: {
      uploaded: uploaded.length,
      external: images.filter((i) => i.kind === 'external').length,
      details: uploaded,
    },
    url,
    message:
      'Created as a PRIVATE DRAFT. It is not published and no one else can see it yet — ' +
      'review it, then publish or widen visibility as a separate, explicit step.',
  });
}

// ── entrypoint ───────────────────────────────────────────────────────────────

function main(argv = process.argv, deps = {}) {
  const subcommand = argv[2];
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    usage();
    process.exit(0);
  }
  const args = parseArgs(argv, 3);
  if (args.help) {
    usage();
    process.exit(0);
  }

  switch (subcommand) {
    case 'validate':
      return cmdValidate(args);
    case 'create':
      return cmdCreate(args, deps);
    default:
      return fail(`Unknown subcommand: ${subcommand}. Run with --help to see options.`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), 'internal', 2);
  }
}

module.exports = {
  main,
  _internals: {
    validateBody,
    titleFromBody,
    buildDocument,
    collectImages,
    applyReplacements,
    scanLines,
    collectHeadings,
    lastJson,
    REQUIRED_SECTIONS,
    CANONICAL_ORDER,
    DEPARTMENTS,
    DEFAULT_COLLECTION,
    LOGO_PATH,
  },
};
