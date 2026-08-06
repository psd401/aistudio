'use strict';
// Tests for chat-chart's engine selection and its on-host (local) renderer.
//
// Engine policy (issue #1596, keeping REV-INFRA-002 intact):
//   - `auto` (the default) and `local` render on-host. Nothing leaves PSD AWS,
//     so sensitive/student data charts normally instead of being refused.
//   - `quickchart` transmits the chart spec to third-party quickchart.io, so it
//     runs ONLY when named explicitly AND the data is neither flagged
//     --sensitive nor matching a PII pattern. Otherwise: refuse, never
//     silently downgrade.
//
// Run: node --test   (from infra/agent-image/skills/chat-chart/)

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const { chooseEngine, buildChartJsConfig } = require('./run.js');
const {
  renderChartPng,
  categoryLabelPlan,
  pieLegendPlan,
  formatNumber,
  niceTicks,
  seriesLegendPlan,
  toAsciiLabel,
  truncateLabel,
  OUT_WIDTH,
  OUT_HEIGHT,
} = require('./render_local.js');

// ---------------------------------------------------------------------------
// Engine selection
// ---------------------------------------------------------------------------

test('--sensitive data renders on the local engine instead of being refused', () => {
  const r = chooseEngine({ '--sensitive': true }, 'apples 5, oranges 3');
  assert.strictEqual(r.engine, 'local');
});

test('auto never selects quickchart, whatever the data looks like', () => {
  const samples = [
    'apples 5, oranges 3, pears 7',
    'reach me at a@b.com',
    'ssn 123-45-6789',
    'call (206) 555-1212 today',
    'student 2123456 enrolled',
  ];
  for (const data of samples) {
    assert.strictEqual(chooseEngine({}, data).engine, 'local', `data: "${data}"`);
    assert.strictEqual(
      chooseEngine({ '--engine': 'auto' }, data).engine,
      'local',
      `data: "${data}"`,
    );
  }
});

test('explicit --engine local is unaffected by the sensitivity gate', () => {
  const r = chooseEngine({ '--engine': 'local', '--sensitive': true }, 'anything');
  assert.strictEqual(r.engine, 'local');
  assert.strictEqual(r.reason, 'explicit');
});

test('explicit --engine quickchart for public data still uses quickchart', () => {
  const r = chooseEngine({ '--engine': 'quickchart' }, 'apples 5');
  assert.strictEqual(r.engine, 'quickchart');
  assert.strictEqual(r.reason, 'explicit');
});

test('explicit --engine quickchart cannot bypass --sensitive refusal (REV-INFRA-002)', () => {
  const r = chooseEngine({ '--engine': 'quickchart', '--sensitive': true }, 'apples 5');
  assert.strictEqual(r.engine, 'refuse');
});

test('each PII pattern refuses an explicit --engine quickchart (REV-INFRA-002)', () => {
  const samples = {
    email: 'reach me at a@b.com',
    ssn: 'ssn 123-45-6789',
    'us-phone': 'call (206) 555-1212 today',
    'psd-student-id': 'student 2123456 enrolled',
  };
  for (const [label, data] of Object.entries(samples)) {
    assert.strictEqual(
      chooseEngine({ '--engine': 'quickchart' }, data).engine,
      'refuse',
      `expected refusal for ${label}: "${data}"`,
    );
  }
});

test('a refusal reason embeds no URL and names the way forward', () => {
  // engine==='refuse' means main() calls fail() before renderQuickChart(), so
  // no quickchart.io URL is ever constructed. (Checked via a bare URL-scheme
  // match, not a domain substring — CodeQL flags `.includes('https://<domain>')`
  // as an incomplete URL sanitization pattern.)
  const r = chooseEngine({ '--engine': 'quickchart', '--sensitive': true }, 'anything');
  assert.doesNotMatch(String(r.reason), /https?:\/\//);
  assert.match(String(r.reason), /on-host/);
});

// ---------------------------------------------------------------------------
// The gate as the CLI actually applies it
//
// chooseEngine() only sees the text main() hands it. These drive the real
// binary so the gate is tested against what QuickChart would receive, not
// against a string a test author chose.
// ---------------------------------------------------------------------------

function runCli(argv) {
  return spawnSync(process.execPath, [path.join(__dirname, 'run.js'), ...argv], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

test('JSON-escaped PII cannot slip past the quickchart gate', () => {
  // The raw argv holds no "@" and no literal student-ID digits — only
  // \u-escapes that JSON.parse restores. Gating on argv missed this.
  const result = runCli([
    '--engine', 'quickchart',
    '--type', 'bar',
    '--data-json', '[{"label":"jsmith\\u0040psd401.net","value":3},{"label":"sid \\u0032123456","value":4}]',
  ]);
  assert.strictEqual(result.status, 3, result.stderr);
  assert.match(result.stderr, /email|psd-student-id/);
  assert.doesNotMatch(result.stdout, /quickchart/);
});

test('PII in --title refuses an explicit quickchart render', () => {
  // The title is embedded in the QuickChart URL twice (chart title + series
  // label), so it has to be inside the gate's field of view.
  const result = runCli([
    '--engine', 'quickchart',
    '--type', 'bar',
    '--data-json', '[{"label":"a","value":1}]',
    '--title', 'SSN 123-45-6789 for jsmith@psd401.net',
  ]);
  assert.strictEqual(result.status, 3, result.stderr);
  assert.doesNotMatch(result.stdout, /quickchart/);
});

test('genuinely public data still reaches quickchart when asked for by name', () => {
  const result = runCli([
    '--engine', 'quickchart',
    '--type', 'bar',
    '--data-json', '[{"label":"Mon","value":5}]',
    '--title', 'Public volume',
  ]);
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /^https:\/\/quickchart\.io\/chart\?/m);
  assert.match(result.stdout, /PSD_AGENT_RICH_V1/);
});

test('Infinity is rejected at the CLI boundary, whatever the engine', () => {
  // JSON.parse('1e999') is Infinity, which is typeof 'number' — it used to
  // pass validation and serialise into the QuickChart URL as `null`.
  const result = runCli(['--type', 'bar', '--data-json', '[{"label":"A","value":1e999}]']);
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /finite/);
});

test('a malformed --user is rejected on every engine, as documented', () => {
  const result = runCli([
    '--type', 'bar',
    '--engine', 'quickchart',
    '--data-json', '[{"label":"A","value":1}]',
    '--user', 'not an email',
  ]);
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /--user/);
});

test('the PII scan is linear enough to survive a 120KB payload', () => {
  // Unbounded quantifiers in the email pattern took ~5s on 60KB and ~25s on
  // 120KB (argv allows it), which is a free CPU burn on the agent container.
  const payload = JSON.stringify([{ label: 'a'.repeat(120_000), value: 1 }]);
  const started = process.hrtime.bigint();
  const result = runCli(['--engine', 'quickchart', '--type', 'bar', '--data-json', payload]);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.strictEqual(result.status, 0, result.stderr);
  assert.ok(elapsedMs < 5000, `PII scan + render took ${Math.round(elapsedMs)}ms`);
});

// ---------------------------------------------------------------------------
// The local engine end to end, through main()
//
// Everything above either unit-tests renderChartPng() directly or drives the
// CLI down the *quickchart* path. That left the engine now serving ~100% of
// real traffic with no test of main()'s wiring — args -> renderChartPng ->
// publishArtifact -> stdout envelope. These close that gap against a stub
// broker on the port agent-broker.js hardcodes.
//
// spawnSync() cannot be used here: it blocks the event loop, so an
// in-process stub server would never get to answer the child's requests.
// ---------------------------------------------------------------------------

const BROKER_PORT = 18_791;
const RICH_OPEN = '<<<PSD_AGENT_RICH_V1>>>';
const RICH_CLOSE = '<<<END_PSD_AGENT_RICH_V1>>>';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

// The broker port is fixed in agent-broker.js, so only ONE stub can be bound
// at a time. `node --test` runs this file's tests sequentially and never
// noticed; `bun test` runs async tests concurrently, so two of them raced to
// listen and the loser died with EADDRINUSE. That surfaced the moment the file
// grew more broker-using tests — it was latent, not new. Serialise on a promise
// chain so every stub gets the port to itself regardless of runner.
let brokerLock = Promise.resolve();

/** Stub of the agent broker's workspace-storage publish/upload/complete contract. */
function withStubBroker(run, options = {}) {
  const result = brokerLock.then(() => withStubBrokerExclusive(run, options));
  // Keep the chain alive even when a test fails, or one rejection wedges the
  // rest of the file behind it.
  brokerLock = result.then(() => undefined, () => undefined);
  return result;
}

async function withStubBrokerExclusive(run, { failPublish = false } = {}) {
  const uploads = [];
  const brokerCalls = [];
  const server = http.createServer((req, res) => {
    if (failPublish) {
      // Simulate a broker that is up but refuses. Asserting on the ABSENCE of
      // a listener instead was racy: bun runs this file's async tests
      // concurrently, so a neighbouring test's stub was often already bound to
      // the fixed port and the publish succeeded.
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'broker unavailable' }));
      return;
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'PUT' && req.url.startsWith('/upload/')) {
        uploads.push({ bytes: body, headers: req.headers });
        res.writeHead(200).end();
        return;
      }
      const payload = JSON.parse(body.toString('utf8'));
      brokerCalls.push({ url: req.url, payload });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (payload.operation === 'publish') {
        // Echo the contract publishArtifact insists on seeing back; any
        // drift here and it throws "incomplete upload" instead of uploading.
        res.end(JSON.stringify({
          uploadUrl: `http://127.0.0.1:${BROKER_PORT}/upload/${payload.path}`,
          reservationId: 'reservation-1',
          requiredHeaders: {
            'Content-Length': String(payload.contentLength),
            'Content-Type': payload.contentType,
            'x-amz-checksum-sha256': payload.checksumSha256,
          },
        }));
        return;
      }
      res.end(JSON.stringify({
        publicUrl: 'https://workspace.example.invalid/charts/stub.png',
        key: 'charts/stub.png',
      }));
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(BROKER_PORT, '127.0.0.1', resolve);
  });
  try {
    return await run({ uploads, brokerCalls });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

function runCliAsync(argv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'run.js'), ...argv]);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
}

function parseEnvelope(stdout) {
  const start = stdout.indexOf(RICH_OPEN);
  const end = stdout.indexOf(RICH_CLOSE);
  assert.ok(start !== -1 && end > start, `no rich envelope in stdout:\n${stdout}`);
  return JSON.parse(stdout.slice(start + RICH_OPEN.length, end).trim());
}

test('a broker failure on the local path exits non-zero rather than printing a card', async () => {
  // The broker is UP and refusing, rather than absent. Testing absence meant
  // testing that no other test happened to be holding the fixed port, which
  // bun's concurrent scheduling made a coin flip.
  const result = await withStubBroker(
    async () => runCliAsync([
      '--type', 'bar',
      '--data-json', '[{"label":"A","value":1}]',
    ]),
    { failPublish: true },
  );
  assert.notStrictEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /PSD_AGENT_RICH_V1/);
});

test('the default engine renders, uploads and emits a card without naming an engine', async () => {
  const { result, uploads, brokerCalls } = await withStubBroker(async ctx => ({
    result: await runCliAsync([
      '--type', 'bar',
      '--title', 'SBA ELA proficiency',
      '--data-json', '[{"label":"Asian","value":71.4},{"label":"White","value":66.3}]',
    ]),
    ...ctx,
  }));

  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /engine=local/);
  assert.strictEqual(
    result.stdout.split('\n')[0],
    'https://workspace.example.invalid/charts/stub.png',
    'first stdout line is the bare URL',
  );

  const envelope = parseEnvelope(result.stdout);
  assert.strictEqual(
    envelope.cardsV2[0].card.sections[0].widgets[0].image.imageUrl,
    'https://workspace.example.invalid/charts/stub.png',
  );
  assert.strictEqual(envelope.cardsV2[0].card.header.title, 'SBA ELA proficiency');
  assert.match(envelope.textFallback, /SBA ELA proficiency/);

  // What actually went up: a real PNG, declared honestly to the broker.
  assert.strictEqual(uploads.length, 1);
  assert.deepStrictEqual(uploads[0].bytes.subarray(0, 8), PNG_SIGNATURE);
  assert.strictEqual(
    uploads[0].headers['x-amz-checksum-sha256'],
    createHash('sha256').update(uploads[0].bytes).digest('base64'),
    'the checksum the broker signed does not cover the bytes that were sent',
  );
  assert.strictEqual(brokerCalls[0].payload.contentType, 'image/png');
  assert.strictEqual(brokerCalls[0].payload.contentLength, uploads[0].bytes.length);
  assert.strictEqual(brokerCalls.at(-1).payload.operation, 'complete-upload');
});

test('issue #1596: --sensitive student data charts instead of exiting 3', async () => {
  // The exact scenario from the issue — an achievement gap by race/ethnicity,
  // flagged sensitive. This used to exit 3 with no chart at all.
  const { result, uploads } = await withStubBroker(async ctx => ({
    result: await runCliAsync([
      '--sensitive',
      '--type', 'bar',
      '--title', 'SBA ELA proficiency by race/ethnicity',
      '--data-json', JSON.stringify([
        { label: 'Am. Indian', value: 38.2 },
        { label: 'Asian', value: 71.4 },
        { label: 'Black', value: 44.9 },
        { label: 'Hispanic', value: 52.1 },
        { label: '2+ Races', value: 58.7 },
        { label: 'White', value: 66.3 },
      ]),
    ]),
    ...ctx,
  }));

  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /engine=local/);
  assert.doesNotMatch(result.stdout, /quickchart/);
  assert.doesNotMatch(result.stderr, /quickchart/);
  assert.strictEqual(uploads.length, 1, 'the chart was never uploaded');
  assert.deepStrictEqual(uploads[0].bytes.subarray(0, 8), PNG_SIGNATURE);
});

// ---------------------------------------------------------------------------
// Local renderer — PNG container
// ---------------------------------------------------------------------------

const BAR_CONFIG = buildChartJsConfig(
  'bar',
  [
    { label: 'American Indian', value: 38.2 },
    { label: 'Asian', value: 71.4 },
    { label: 'Black', value: 44.9 },
  ],
  'SBA ELA proficiency by race/ethnicity',
);

function parsePngChunks(png) {
  assert.deepStrictEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
    'PNG signature',
  );
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += length + 12;
  }
  return chunks;
}

test('the local engine emits a decodable PNG of the documented size', () => {
  const png = renderChartPng(BAR_CONFIG);
  const chunks = parsePngChunks(png);
  assert.deepStrictEqual(
    chunks.map(c => c.type),
    ['IHDR', 'IDAT', 'IEND'],
  );
  const ihdr = chunks[0].data;
  assert.strictEqual(ihdr.readUInt32BE(0), OUT_WIDTH);
  assert.strictEqual(ihdr.readUInt32BE(4), OUT_HEIGHT);
  assert.strictEqual(ihdr[8], 8, 'bit depth');
  assert.strictEqual(ihdr[9], 2, 'colour type: truecolour');
  // The IDAT stream must inflate to exactly one filter byte + one RGB row per
  // scanline; a wrong stride is the classic way to ship a corrupt PNG.
  const raw = zlib.inflateSync(chunks[1].data);
  assert.strictEqual(raw.length, (OUT_WIDTH * 3 + 1) * OUT_HEIGHT);
  for (let y = 0; y < OUT_HEIGHT; y++) {
    assert.strictEqual(raw[y * (OUT_WIDTH * 3 + 1)], 0, `row ${y} filter byte`);
  }
});

/**
 * Independent CRC32 oracle for the chunk test below.
 *
 * Deliberately NOT `zlib.crc32`: render_local.js hand-rolls its CRC precisely
 * because that built-in needs Node >= 22.2 and the agent image's Node comes
 * from an unpinned base image. Using it as the oracle would make this test
 * fail on exactly the runtimes the production code was written to survive —
 * a red suite reporting the test's own assumption, not a renderer defect.
 *
 * This is also structurally different from the implementation it checks:
 * bit-at-a-time long division, no 256-entry lookup table, so a mistake in
 * building that table cannot cancel out against the oracle.
 */
function referenceCrc32(buffer) {
  let crc = 0xFF_FF_FF_FF;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xED_B8_83_20 : crc >>> 1;
    }
  }
  return (crc ^ 0xFF_FF_FF_FF) >>> 0;
}

test('the CRC32 oracle agrees with the published check values', () => {
  // Pinned vectors from the CRC-32/ISO-HDLC definition, so a broken oracle
  // is caught here rather than silently blessing a broken renderer.
  assert.strictEqual(referenceCrc32(Buffer.from('')), 0);
  assert.strictEqual(referenceCrc32(Buffer.from('123456789')), 0xCB_F4_39_26);
  assert.strictEqual(referenceCrc32(Buffer.from('IEND')), 0xAE_42_60_82);
});

test('each chunk carries a correct CRC32', () => {
  const png = renderChartPng(BAR_CONFIG);
  let offset = 8;
  let chunks = 0;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const declared = png.readUInt32BE(offset + 8 + length);
    const actual = referenceCrc32(png.subarray(offset + 4, offset + 8 + length));
    assert.strictEqual(actual, declared, `CRC at offset ${offset}`);
    offset += length + 12;
    chunks++;
  }
  assert.ok(chunks >= 3, `expected IHDR/IDAT/IEND at least, checked ${chunks}`);
});

// ---------------------------------------------------------------------------
// Local renderer — pixels
// ---------------------------------------------------------------------------

function decodePixels(png) {
  const chunks = parsePngChunks(png);
  const raw = zlib.inflateSync(chunks.find(c => c.type === 'IDAT').data);
  const stride = OUT_WIDTH * 3;
  const pixels = Buffer.alloc(stride * OUT_HEIGHT);
  for (let y = 0; y < OUT_HEIGHT; y++) {
    raw.copy(pixels, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  }
  return pixels;
}

const PALETTE_BLUE = [31, 119, 180];
const PALETTE_RED = [214, 39, 40];
const NAMED_COLOURS = [
  [255, 255, 255], PALETTE_BLUE, PALETTE_RED,
  [44, 160, 44], [255, 127, 14], [148, 103, 189], [23, 190, 207],
  [227, 119, 194], [140, 86, 75], [127, 127, 127], [188, 189, 34],
  [33, 33, 33], [90, 90, 90], [219, 219, 219],
];

// Bands in OUTPUT pixel space, expressed loosely enough to survive small
// layout tweaks: the title sits above the plot, y tick labels left of it,
// category labels below it.
const TITLE_BAND = { x0: 0, y0: 0, x1: OUT_WIDTH, y1: 60 };
const Y_LABEL_BAND = { x0: 0, y0: 60, x1: 85, y1: OUT_HEIGHT - 80 };
const X_LABEL_BAND = { x0: 0, y0: 432, x1: OUT_WIDTH, y1: OUT_HEIGHT };
const PLOT_BAND = { x0: 100, y0: 60, x1: 765, y1: 420 };
const LEFT_EDGE = { x0: 0, y0: 0, x1: 3, y1: 60 };
const RIGHT_EDGE = { x0: OUT_WIDTH - 3, y0: 0, x1: OUT_WIDTH, y1: 60 };

function pixelAt(pixels, x, y) {
  const offset = (y * OUT_WIDTH + x) * 3;
  return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
}

function sameColour(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function isWhite(px) {
  return px[0] === 255 && px[1] === 255 && px[2] === 255;
}

/**
 * Dark pixels — lettering and its anti-aliased edges. Every series colour,
 * the gridlines and the axis rules are lighter than this, so inside the plot
 * a dark pixel can only be a glyph. (Exact-colour matching undercounts badly:
 * at tick scale most glyph pixels survive downsampling as blends.)
 */
function textInk(pixels, band) {
  let count = 0;
  for (let y = band.y0; y < band.y1; y++) {
    for (let x = band.x0; x < band.x1; x++) {
      const px = pixelAt(pixels, x, y);
      if (px[0] < 120 && px[1] < 120 && px[2] < 120) count++;
    }
  }
  return count;
}

function countNonWhite(pixels, band) {
  const region = band ?? { x0: 0, y0: 0, x1: OUT_WIDTH, y1: OUT_HEIGHT };
  let count = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      if (!isWhite(pixelAt(pixels, x, y))) count++;
    }
  }
  return count;
}

/** Rows/columns covered by an exact colour, plus its pixel count. */
function extent(pixels, colour) {
  let count = 0;
  let minX = OUT_WIDTH;
  let maxX = -1;
  let minY = OUT_HEIGHT;
  let maxY = -1;
  let leftmostY = -1;
  let rightmostY = -1;
  for (let y = 0; y < OUT_HEIGHT; y++) {
    for (let x = 0; x < OUT_WIDTH; x++) {
      if (!sameColour(pixelAt(pixels, x, y), colour)) continue;
      count++;
      if (x < minX) { minX = x; leftmostY = y; }
      if (x > maxX) { maxX = x; rightmostY = y; }
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { count, minX, maxX, minY, maxY, leftmostY, rightmostY };
}

function render(type, data, title) {
  return decodePixels(renderChartPng(buildChartJsConfig(type, data, title)));
}

test('bars hang from a shared zero baseline, in proportion to their values', () => {
  // Catches drawing bars from the axis floor instead of the zero line: the
  // bars still "render ink" and can still touch at a shared row, but their
  // heights stop matching 6:4.
  const pixels = render('bar', [{ label: 'Up', value: 6 }, { label: 'Down', value: -4 }], 'Change');
  const positive = extent(pixels, PALETTE_BLUE);
  const negative = extent(pixels, PALETTE_RED);
  assert.ok(positive.count > 500 && negative.count > 500, 'both bars are painted');
  assert.ok(
    Math.abs(negative.minY - positive.maxY) <= 3,
    `bars should meet at one baseline: positive ends y=${positive.maxY}, negative starts y=${negative.minY}`,
  );
  assert.ok(negative.maxY > positive.maxY, 'the negative bar extends below the baseline');
  const posHeight = positive.maxY - positive.minY;
  const negHeight = negative.maxY - negative.minY;
  const ratio = posHeight / negHeight;
  assert.ok(
    ratio > 1.2 && ratio < 1.8,
    `6 and -4 should render 1.5:1, got ${posHeight}:${negHeight}`,
  );
});

test('pie slices are painted in series colours', () => {
  const pixels = render('pie', [{ label: 'Meets', value: 38 }, { label: 'Below', value: 62 }], 'Levels');
  const first = extent(pixels, PALETTE_BLUE);
  const second = extent(pixels, PALETTE_RED);
  assert.ok(first.count > 5000, `first wedge only ${first.count} px`);
  assert.ok(second.count > 5000, `second wedge only ${second.count} px`);
  assert.ok(second.count > first.count, '62% should out-paint 38%');
});

test('scatter markers land on the right axes, not transposed', () => {
  // (1,2) and (3,9): the rightmost marker must also be the higher one. A
  // swapped toX/toY mapping breaks that relationship.
  const pixels = render('scatter', [{ x: 1, y: 2 }, { x: 3, y: 9 }], 'Correlation');
  const marks = extent(pixels, PALETTE_BLUE);
  assert.ok(marks.count > 80, `markers only ${marks.count} px`);
  assert.ok(
    marks.rightmostY < marks.leftmostY - 50,
    `rightmost marker (y=${marks.rightmostY}) should sit well above the leftmost (y=${marks.leftmostY})`,
  );
});

test('line charts connect their markers', () => {
  // Three markers alone are ~150px; the connecting segments dominate. This
  // fails if drawLineSegment is skipped.
  const pixels = render(
    'line',
    [
      { label: 'a', value: 1 },
      { label: 'b', value: 9 },
      { label: 'c', value: 2 },
    ],
    'Trend',
  );
  const ink = extent(pixels, PALETTE_BLUE);
  assert.ok(ink.count > 900, `line ink was ${ink.count} px — markers without segments?`);
  assert.ok(ink.maxY - ink.minY > 200, 'the series should span most of the plot height');
});

test('every chart type letters its axes and title', () => {
  for (const [type, data] of Object.entries({
    bar: [{ label: 'Mon', value: 12 }, { label: 'Tue', value: 8 }],
    line: [{ label: 'Mon', value: 12 }, { label: 'Tue', value: 8 }],
    scatter: [{ x: 1, y: 2 }, { x: 3, y: 9 }],
  })) {
    const pixels = render(type, data, 'A title');
    assert.ok(countNonWhite(pixels, TITLE_BAND) > 100, `${type}: title band is blank`);
    assert.ok(
      countNonWhite(pixels, Y_LABEL_BAND) > 50,
      `${type}: y tick labels are missing`,
    );
    assert.ok(
      countNonWhite(pixels, X_LABEL_BAND) > 50,
      `${type}: x axis labels are missing`,
    );
  }
});

test('the title is lettered when given, and the band is reclaimed when not', () => {
  // Counting *text-coloured* pixels, not any ink: an untitled chart grows the
  // plot into that band, so total ink there goes UP without a title.
  const titled = render('bar', [{ label: 'A', value: 1 }], 'Titled');
  const bare = render('bar', [{ label: 'A', value: 1 }], null);
  assert.ok(textInk(titled, TITLE_BAND) > 300, 'title glyphs are missing');
  assert.ok(textInk(bare, TITLE_BAND) < 100, 'untitled charts letter nothing there');
  assert.ok(extent(bare, PALETTE_BLUE).count > 1000, 'the bar still renders');
});

test('missing labels fall back to ordinal positions', () => {
  const pixels = decodePixels(
    renderChartPng({ type: 'bar', data: { datasets: [{ data: [1, 2, 3] }] }, options: {} }),
  );
  assert.ok(
    countNonWhite(pixels, X_LABEL_BAND) > 50,
    'ordinal labels should still be lettered under the axis',
  );
});

test('dense axes drop whole labels rather than crowding the band', () => {
  const sparse = render(
    'bar',
    Array.from({ length: 6 }, (_, i) => ({ label: `Week ${i + 1}`, value: i + 1 })),
    'Six',
  );
  const dense = render(
    'bar',
    Array.from({ length: 50 }, (_, i) => ({ label: `Week ${i + 1}`, value: i + 1 })),
    'Fifty',
  );
  const sparseInk = countNonWhite(sparse, X_LABEL_BAND);
  const denseInk = countNonWhite(dense, X_LABEL_BAND);
  assert.ok(denseInk > 50, 'a dense axis still gets labels');
  assert.ok(
    denseInk < sparseInk * 2.5,
    `50 categories inked ${denseInk} px vs ${sparseInk} for 6 — labels were not thinned`,
  );
});

test('downsampling averages rather than picking a nearest pixel', () => {
  // Averaged 2x supersampling leaves blended edge pixels. Nearest-neighbour
  // downsampling would leave only exact palette colours.
  const pixels = render('pie', [{ label: 'A', value: 1 }, { label: 'B', value: 2 }], 'Blend');
  let blended = 0;
  for (let y = 0; y < OUT_HEIGHT; y++) {
    for (let x = 0; x < OUT_WIDTH; x++) {
      const px = pixelAt(pixels, x, y);
      if (!NAMED_COLOURS.some(colour => sameColour(px, colour))) blended++;
    }
  }
  assert.ok(blended > 200, `only ${blended} blended pixels — anti-aliasing lost?`);
});

test('bar value labels are drawn when they fit and dropped when they do not', () => {
  // Inside the plot, text-coloured pixels can only be per-bar value labels:
  // gridlines and bars use their own colours.
  const sparse = render('bar', [{ label: 'Mon', value: 12 }, { label: 'Tue', value: 8 }], 'Two');
  const dense = render(
    'bar',
    Array.from({ length: 50 }, (_, i) => ({ label: `W${i + 1}`, value: 40 + (i % 7) })),
    'Fifty',
  );
  assert.ok(textInk(sparse, PLOT_BAND) > 30, 'two bars should carry value labels');
  assert.strictEqual(
    textInk(dense, PLOT_BAND),
    0,
    '50 bars have no room for value labels; they must be dropped, not overprinted',
  );
});

test('a long title is truncated to fit, never clipped at the canvas edges', () => {
  // Centred text overruns BOTH edges when the budget is too generous, so a
  // too-long title used to lose characters from each end.
  const pixels = render('bar', [{ label: 'A', value: 1 }], 'C'.repeat(80));
  assert.strictEqual(countNonWhite(pixels, LEFT_EDGE), 0, 'title ran off the left edge');
  assert.strictEqual(countNonWhite(pixels, RIGHT_EDGE), 0, 'title ran off the right edge');
  assert.ok(textInk(pixels, TITLE_BAND) > 300, 'the title is still drawn');
});

test('the pie legend never plans more rows than the canvas holds', () => {
  const area = { top: 150, bottom: 850, height: 700 };
  for (const count of [2, 10, 19, 25, 50]) {
    const plan = pieLegendPlan(count, area);
    assert.ok(plan.shown >= 1, `${count} slices: nothing shown`);
    assert.strictEqual(plan.shown + plan.hidden, count, `${count} slices: rows lost`);
    const rows = plan.shown + (plan.hidden > 0 ? 1 : 0);
    assert.ok(
      rows * plan.rowHeight <= area.height,
      `${count} slices: ${rows} rows of ${plan.rowHeight} overflow ${area.height}`,
    );
  }
  assert.strictEqual(pieLegendPlan(10, area).hidden, 0, '10 slices all fit');
  assert.ok(pieLegendPlan(50, area).hidden > 0, '50 slices cannot all fit');
});

test('rendering is deterministic for identical input', () => {
  const a = renderChartPng(BAR_CONFIG);
  const b = renderChartPng(BAR_CONFIG);
  assert.ok(a.equals(b));
});

test('a crowded pie legend stops at the canvas instead of running off it', () => {
  // A wedge carries no label of its own, so a legend row that runs off the
  // bottom takes its slice's identity with it, silently.
  const many = Array.from({ length: 50 }, (_, i) => ({ label: `School ${i + 1}`, value: 4 }));
  const pixels = render('pie', many, '50 schools');
  const legendFoot = { x0: 470, y0: 440, x1: OUT_WIDTH, y1: OUT_HEIGHT };
  assert.strictEqual(countNonWhite(pixels, legendFoot), 0, 'legend ran off the canvas');
  assert.ok(extent(pixels, PALETTE_BLUE).count > 1000, 'wedges still painted');
});

// ---------------------------------------------------------------------------
// Local renderer — input validation
// ---------------------------------------------------------------------------

test('the renderer throws (never exits) on unusable input', () => {
  const cases = [
    [{ type: 'bar', data: { datasets: [] } }, /datasets is empty/],
    [{ type: 'bar', data: { datasets: [{ data: [] }] } }, /data is empty/],
    [
      { type: 'bar', data: { labels: ['a'], datasets: [{ data: ['nope'] }] } },
      /non-numeric/,
    ],
    [
      { type: 'sunburst', data: { labels: ['a'], datasets: [{ data: [1] }] } },
      /unsupported chart type/,
    ],
    [
      { type: 'pie', data: { labels: ['a', 'b'], datasets: [{ data: [1, -2] }] } },
      /non-negative/,
    ],
    [
      { type: 'pie', data: { labels: ['a'], datasets: [{ data: [0] }] } },
      /positive number/,
    ],
    [{ type: 'scatter', data: { datasets: [{ data: [{ x: 1 }] }] } }, /numeric x\/y/],
  ];
  for (const [config, pattern] of cases) {
    assert.throws(() => renderChartPng(config), pattern, JSON.stringify(config));
  }
});

test('a pie whose total overflows is refused, not painted as one slice', () => {
  // Each value is finite, so per-value validation passes, but the sum is
  // Infinity — which clears `total <= 0`. Every share then computes as
  // value/Infinity === 0, so the legend reads 0% for both slices while the
  // forced final wedge bound paints the entire circle as the last category.
  // That is a wrong chart returned as a success, which is the failure worth
  // guarding against.
  const config = {
    type: 'pie',
    data: { labels: ['a', 'b'], datasets: [{ data: [1e308, 1e308] }] },
  };
  assert.throws(() => renderChartPng(config), /cannot be divided into shares/);
});

test('a range too narrow for its magnitude is refused, not looped over', () => {
  // Accumulating `value += step` when step is below an ULP of the start never
  // advances: the tick array grows until the process dies of heap exhaustion.
  // Two nanosecond-epoch timestamps 300ns apart do exactly this, on the
  // DEFAULT engine with no flags.
  assert.throws(() => niceTicks(1, 1.0000000000000002), /too narrow/);
  assert.throws(
    () =>
      renderChartPng(
        buildChartJsConfig(
          'scatter',
          [
            { x: 1_700_000_000_000_000_000, y: 1 },
            { x: 1_700_000_000_000_000_300, y: 2 },
          ],
          'nanoseconds',
        ),
      ),
    /too narrow/,
  );
});

test('small-magnitude axes keep distinct ticks that still cover the data', () => {
  // Rounding ticks with toFixed(10) collapsed everything below ~1e-6 onto one
  // number, leaving an axis that no longer spanned its own data.
  const min = 4.231635042520979e-7;
  const max = 4.231910318490414e-7;
  const ticks = niceTicks(min, max);
  assert.strictEqual(new Set(ticks).size, ticks.length, `duplicate ticks: ${ticks}`);
  assert.ok(ticks[0] <= min, `first tick ${ticks[0]} is above the data`);
  assert.ok(ticks.at(-1) >= max, `last tick ${ticks.at(-1)} is below the data`);
});

test('a value range too large to plot is reported, not silently blank', () => {
  // 1e308 - (-1e308) overflows to Infinity, which would make every tick NaN
  // and paint nothing at all.
  assert.throws(
    () =>
      renderChartPng(
        buildChartJsConfig(
          'bar',
          [
            { label: 'max', value: 1e308 },
            { label: 'min', value: -1e308 },
          ],
          'overflow',
        ),
      ),
    /too large to plot/,
  );
});

test('non-finite values are named in the error, not stringified to null', () => {
  const config = { type: 'bar', data: { labels: ['a'], datasets: [{ data: [Number.NaN] }] } };
  assert.throws(() => renderChartPng(config), /non-numeric data point: NaN/);
});

test('more points than the documented ceiling is rejected, not truncated', () => {
  const data = Array.from({ length: 51 }, (_, i) => ({ label: `L${i}`, value: i }));
  assert.throws(
    () => renderChartPng(buildChartJsConfig('bar', data, 'too many')),
    /too many data points/,
  );
});

// ---------------------------------------------------------------------------
// Local renderer — helpers
// ---------------------------------------------------------------------------

test('non-ASCII label characters degrade to ? rather than blowing up the font', () => {
  assert.strictEqual(toAsciiLabel('Sanchez — 5th'), 'Sanchez ? 5th');
  assert.strictEqual(toAsciiLabel(undefined), '');
  assert.strictEqual(toAsciiLabel(42), '42');
});

test('labels truncate with a trailing dot and never exceed the budget', () => {
  assert.strictEqual(truncateLabel('American Indian', 9), 'American.');
  assert.strictEqual(truncateLabel('Asian', 9), 'Asian');
  assert.strictEqual(truncateLabel('Asian', 0), '');
  // At a 1-char budget there is no room for the dot, and adding one anyway
  // returns a string LONGER than the budget it was asked to fit.
  assert.strictEqual(truncateLabel('Asian', 1), 'A');
  for (let budget = 0; budget <= 8; budget++) {
    assert.ok(
      truncateLabel('American Indian', budget).length <= budget,
      `budget ${budget} produced "${truncateLabel('American Indian', budget)}"`,
    );
  }
});

test('dense category axes thin whole labels instead of printing stubs', () => {
  // Plot width is DEVICE_WIDTH - margins; slot = plotWidth / categories.
  const PLOT_WIDTH = OUT_WIDTH * 2 - 190 - 60;
  const plan = (labels) => categoryLabelPlan(labels, PLOT_WIDTH / labels.length);

  const short = plan(['Mon', 'Tue', 'Wed']);
  assert.strictEqual(short.stride, 1);
  assert.ok(short.maxChars >= 3, 'short labels are never truncated');

  const wide = plan(['Am. Indian', 'Asian', 'Black', 'Hispanic', '2+ Races', 'White']);
  assert.strictEqual(wide.stride, 1);
  assert.ok(wide.maxChars >= 10, 'a 6-category axis still fits whole labels');

  const dates = plan(Array.from({ length: 14 }, (_, i) => `2026-05-${10 + i}`));
  assert.ok(dates.stride > 1, '14 dates cannot all be lettered side by side');
  assert.ok(dates.maxChars >= 10, 'thinned dates stay whole, not "202."');

  const weeks = plan(Array.from({ length: 50 }, (_, i) => `Week ${i + 1}`));
  assert.ok(weeks.stride >= 2);
  assert.ok(weeks.maxChars >= 7, 'thinned weeks keep their distinguishing number');
});

test('few categories truncate rather than dropping a label entirely', () => {
  const plan = categoryLabelPlan(['A'.repeat(60), 'B'.repeat(60)], 200);
  assert.strictEqual(plan.stride, 1);
});

test('axis numbers stay short and readable', () => {
  assert.strictEqual(formatNumber(12), '12');
  assert.strictEqual(formatNumber(0.94), '0.94');
  assert.strictEqual(formatNumber(1234.5), '1234.5');
  assert.strictEqual(formatNumber(25_000), '25k');
  assert.strictEqual(formatNumber(3_400_000), '3.4M');
  assert.strictEqual(formatNumber(Number.NaN), '');
  // One decimal place is coarser than the steps these axes actually use:
  // 1.00M / 1.02M / 1.04M all printed "1.0M", an axis that claimed the data
  // was flat. Adjacent ticks must stay distinguishable.
  assert.notStrictEqual(formatNumber(1_020_000), formatNumber(1_040_000));
  assert.strictEqual(formatNumber(1_020_000), '1.02M');
  assert.notStrictEqual(formatNumber(10_000), formatNumber(10_010));
  // Suffixes continue past M, and the widest label still fits the margin.
  assert.strictEqual(formatNumber(5e9), '5B');
  assert.strictEqual(formatNumber(5e12), '5T');
  assert.strictEqual(formatNumber(1e16), '1.0e+16');
  // One axis must not mix "1.50" with "0.5".
  assert.strictEqual(formatNumber(1.5), '1.5');
});

test('the axis actually labels distinct ticks at million scale', () => {
  const labels = niceTicks(1_000_000, 1_100_000).map(tick => formatNumber(tick));
  assert.strictEqual(new Set(labels).size, labels.length, labels.join(','));
});

test('tick steps are evenly spaced and span the data', () => {
  const ticks = niceTicks(0, 71.4);
  assert.ok(ticks[0] <= 0);
  assert.ok(ticks.at(-1) >= 71.4);
  const step = ticks[1] - ticks[0];
  for (const [index, tick] of ticks.entries()) {
    assert.ok(Math.abs(tick - (ticks[0] + index * step)) < 1e-6, 'evenly spaced');
  }
  const tight = niceTicks(0.938, 0.962);
  assert.ok(tight.at(-1) - tight[0] < 0.1, 'narrow ranges keep a narrow axis');
});

test('a flat series still produces a usable axis', () => {
  const ticks = niceTicks(5, 5);
  assert.ok(ticks.length >= 2);
  assert.ok(ticks.at(-1) > ticks[0]);
});

// ---------------------------------------------------------------------------
// Multi-series (2026-08-06)
//
// The renderer read only datasets[0], so "chart Reading and Math by grade"
// drew Math alone with a plausible axis and no sign a series was missing.
// Half the data presented as all of it is worse than a refusal.
// ---------------------------------------------------------------------------

test('the CLI builds one dataset per named series, in the order given', () => {
  const cfg = buildChartJsConfig('bar', [
    { label: 'Grade 1', values: { Math: 412, Reading: 398 } },
    { label: 'Grade 2', values: { Math: 441, Reading: 430 } },
  ], 'i-Ready');
  assert.deepEqual(cfg.data.datasets.map(d => d.label), ['Math', 'Reading']);
  assert.deepEqual(cfg.data.datasets[0].data, [412, 441]);
  assert.deepEqual(cfg.data.datasets[1].data, [398, 430]);
  assert.deepEqual(cfg.data.labels, ['Grade 1', 'Grade 2']);
});

test('the single-series shape is unchanged', () => {
  const cfg = buildChartJsConfig('bar', [{ label: 'A', value: 1 }], 't');
  assert.strictEqual(cfg.data.datasets.length, 1);
  assert.deepEqual(cfg.data.datasets[0].data, [1]);
});

test('a series missing a value at one point is rejected, not silently zeroed', () => {
  const result = runCli([
    '--type', 'bar',
    '--data-json', '[{"label":"G1","values":{"Math":1,"Reading":2}},{"label":"G2","values":{"Math":3}}]',
  ]);
  assert.notStrictEqual(result.status, 0);
  assert.match(result.stderr, /Reading/);
});

test('a legend that cannot fit is refused, not clipped off the canvas', () => {
  // widestThatFits used to bottom out at 4 characters and report that as a
  // valid plan even when it did not fit: 21 series became 11 entries per row,
  // measuring 1440px inside a 1350px plot, so the last series was drawn past
  // the right edge and could not be identified.
  const series = (n) => ({
    type: 'bar',
    data: {
      labels: ['A', 'B'],
      datasets: Array.from({ length: n }, (_, i) => ({ label: `Srs${i}`, data: [i + 1, i + 2] })),
    },
    options: {},
  });

  assert.strictEqual(seriesLegendPlan(21, 1350, 3).maxChars, 0, 'an unfittable plan must not claim a width');
  assert.ok(seriesLegendPlan(20, 1350, 3).maxChars > 0);

  assert.throws(() => renderChartPng(series(21)), /too many series to label \(21\)/);
  // The refusal names a number the caller can act on rather than just refusing.
  assert.throws(() => renderChartPng(series(21)), /at most 20/);
  // And the boundary still renders — the guard must not cost a legal chart.
  assert.ok(renderChartPng(series(20)).length > 0);
});

test('a renderer failure is reported, not just exited on', () => {
  // renderLocal used to call the synchronous fail(), which process.exit()s
  // before main()'s rejection handler can run — so the one failure class this
  // skill's telemetry was added for emitted no AGENT_FAILURE_RECORD at all.
  const oversized = JSON.stringify(
    Array.from({ length: 51 }, (_, i) => ({ label: `L${i}`, value: i })),
  );
  const result = runCli(['--type', 'bar', '--data-json', oversized]);

  assert.match(result.stderr, /AGENT_FAILURE_RECORD/);
  const record = JSON.parse(
    result.stderr.slice(result.stderr.indexOf('AGENT_FAILURE_RECORD ') + 'AGENT_FAILURE_RECORD '.length)
      .split('\n')[0],
  );
  assert.strictEqual(record.error_class, 'ChartRenderFailed');
  assert.strictEqual(record.context.user_facing, true);
  assert.match(record.error_message, /too many data points/);
  // Diagnosed failure: the original wording and exit code both survive the
  // move off fail(), so it is not relabelled as an unexpected error.
  assert.strictEqual(result.status, 3, result.stderr);
  assert.match(result.stderr, /chat-chart: local renderer failed:/);
  assert.doesNotMatch(result.stderr, /unexpected error/);
});

test('a renderer failure reaches the broker, not just stderr', async () => {
  // reportChartFailure swallows every error from the broker call by design, so
  // a wrong route or payload shape would fail silently and the stderr-only
  // assertions above would still pass. That is the exact invisibility this
  // reporting path exists to end, so the POST itself is asserted.
  const oversized = JSON.stringify(
    Array.from({ length: 51 }, (_, i) => ({ label: `L${i}`, value: i })),
  );
  const { result, brokerCalls } = await withStubBroker(async ctx => ({
    result: await runCliAsync(['--type', 'bar', '--data-json', oversized]),
    brokerCalls: ctx.brokerCalls,
  }));

  assert.strictEqual(result.status, 3, result.stderr);
  // The render fails before publishArtifact, so the failure report is the only
  // call the broker should see.
  assert.strictEqual(brokerCalls.length, 1, `unexpected broker traffic: ${JSON.stringify(brokerCalls)}`);
  const [failure] = brokerCalls;
  assert.strictEqual(failure.url, '/agent-broker/api/agent/failures');
  // camelCase on the wire, snake_case in the CloudWatch line — the split is the
  // existing convention (psd-failure-report/report.js), and unverified until now.
  assert.strictEqual(failure.payload.source, 'tool');
  assert.strictEqual(failure.payload.severity, 'error');
  assert.strictEqual(failure.payload.errorClass, 'ChartRenderFailed');
  assert.match(failure.payload.errorMessage, /too many data points/);
  assert.strictEqual(failure.payload.context.tool, 'chat-chart');
  assert.strictEqual(failure.payload.context.type, 'bar');
  assert.strictEqual(failure.payload.context.user_facing, true);
});

test('every dataset is drawn, not just the first', () => {
  // Same categories, wildly different values: if only datasets[0] were drawn
  // the axis could not span the second series' range.
  const png = renderChartPng({
    type: 'bar',
    data: {
      labels: ['A', 'B'],
      datasets: [{ label: 'Low', data: [1, 2] }, { label: 'High', data: [900, 950] }],
    },
    options: {},
  });
  const pixels = decodePixels(png);
  // The second series' palette colour must actually appear on the canvas.
  assert.ok(extent(pixels, PALETTE_RED).count > 200, 'second series was not drawn');
  assert.ok(countNonWhite(pixels) > 2000);
});

test('a multi-series line draws one line per dataset', () => {
  const png = renderChartPng({
    type: 'line',
    data: {
      labels: ['x', 'y', 'z'],
      datasets: [{ label: 'One', data: [1, 2, 3] }, { label: 'Two', data: [3, 2, 1] }],
    },
    options: {},
  });
  const pixels = decodePixels(png);
  assert.ok(extent(pixels, PALETTE_BLUE).count > 100, 'first line missing');
  assert.ok(extent(pixels, PALETTE_RED).count > 100, 'second line missing');
});

test('a multi-series scatter draws every point set, not just the first', () => {
  // drawScatterChart took a flat point array and painted PALETTE[0], while
  // drawChart handed it seriesList[0] only — so a second point set vanished
  // with no error, under a comment claiming each series got its own colour.
  const png = renderChartPng({
    type: 'scatter',
    data: {
      datasets: [
        { label: 'Fall', data: [{ x: 1, y: 1 }, { x: 2, y: 2 }] },
        { label: 'Spring', data: [{ x: 3, y: 30 }, { x: 4, y: 40 }] },
      ],
    },
    options: {},
  });
  const pixels = decodePixels(png);
  const first = extent(pixels, PALETTE_BLUE);
  const second = extent(pixels, PALETTE_RED);
  assert.ok(first.count > 80, `first series only ${first.count} px`);
  assert.ok(second.count > 80, `second series missing (${second.count} px)`);
  // Both axes span both series. Drawing series 0 alone and scaling to it would
  // put Spring's y=30..40 far off the top of a 1..2 axis.
  assert.ok(second.minY < first.minY, 'the second series is not plotted above the first');
  assert.ok(second.minX > first.maxX, 'the second series is not plotted to the right');
});

test('a scatter refuses a legend it cannot fit, like bar and line', () => {
  // The refusal used to sit after scatter's early return, so scatter alone
  // could draw unnameable series past the canvas edge.
  const datasets = Array.from({ length: 21 }, (_, i) => ({
    label: `S${i + 1}`,
    data: [{ x: i, y: i }],
  }));
  assert.throws(
    () => renderChartPng({ type: 'scatter', data: { datasets }, options: {} }),
    /too many series to label \(21\)/,
  );
  assert.ok(renderChartPng({ type: 'scatter', data: { datasets: datasets.slice(0, 20) }, options: {} }).length > 0);
});

test('a single series keeps the full-slot value-label budget it always had', () => {
  // Grouped bars must measure a label against their own bar, but applying that
  // to the single-series path silently dropped every label between 62% and
  // 100% of the slot — a behaviour change the PR did not intend. 16 four-digit
  // bars sit squarely in that band: the label measures 69px against a 52px bar
  // in an 84px slot, so it is drawn under the historical rule and dropped under
  // the grouped one.
  const pixels = render(
    'bar',
    Array.from({ length: 16 }, (_, i) => ({ label: `W${i + 1}`, value: 1000 + i })),
    'Wide',
  );
  assert.ok(
    textInk(pixels, PLOT_BAND) > 30,
    'single-series value labels that fit their slot must still be drawn',
  );
});

test('a pie refuses a second dataset rather than drawing only the first', () => {
  assert.throws(
    () => renderChartPng({
      type: 'pie',
      data: { labels: ['a', 'b'], datasets: [{ data: [1, 2] }, { data: [3, 4] }] },
      options: {},
    }),
    /exactly one dataset/,
  );
});

test('the legend never runs off the canvas', () => {
  // A legend that overflows takes those series' identities with it — the same
  // failure the pie legend had. Asserted on PIXELS rather than by recomputing
  // the layout arithmetic, so the test cannot drift from the renderer.
  const EDGE = 6;
  for (const count of [2, 3, 6, 10]) {
    const png = renderChartPng({
      type: 'bar',
      data: {
        labels: ['A', 'B'],
        datasets: Array.from({ length: count }, (_, i) => ({
          label: `Very Long Series Name Number ${i + 1}`,
          data: [10 + i, 20 + i],
        })),
      },
      options: {},
    });
    const pixels = decodePixels(png);
    const left = { x0: 0, y0: 0, x1: EDGE, y1: OUT_HEIGHT };
    const right = { x0: OUT_WIDTH - EDGE, y0: 0, x1: OUT_WIDTH, y1: OUT_HEIGHT };
    // The vertical direction is the one the horizontal fix did not cover. The
    // legend wraps to LEGEND_MAX_ROWS *below* the axis, and "two rows is what
    // fits at MARGIN.bottom" is an arithmetic claim about the same layout that
    // already overflowed once sideways. 6 and 10 series wrap; 2 and 3 do not,
    // so the loop covers both row counts.
    const bottom = { x0: 0, y0: OUT_HEIGHT - EDGE, x1: OUT_WIDTH, y1: OUT_HEIGHT };
    assert.strictEqual(countNonWhite(pixels, left), 0, `${count} series: ran off the left`);
    assert.strictEqual(countNonWhite(pixels, right), 0, `${count} series: ran off the right`);
    assert.strictEqual(countNonWhite(pixels, bottom), 0, `${count} series: ran off the bottom`);
  }
});

test('the legend wraps rather than truncating every label to the same stub', () => {
  // Six series on one row all render as "Very Long." — identical, identifying
  // nothing. Wrapping buys each label real width.
  const one = seriesLegendPlan(2, 1350, 3);
  const many = seriesLegendPlan(6, 1350, 3);
  assert.strictEqual(one.rows, 1);
  assert.strictEqual(many.rows, 2);
  assert.ok(many.maxChars >= 16, `wrapped labels still only ${many.maxChars} chars`);
});

test('an authoring mistake is reported, not just exited on', () => {
  // The likelier way an agent ends a turn with no chart: asking for Math and
  // Reading by grade and forgetting one grade's Reading score. Every fail()
  // call site used to process.exit() straight past the reporter, so this whole
  // class — bad flags, malformed --data-json, a gap in a series — left nothing
  // in agent_failures however many times a user said the chart never arrived.
  const gap = JSON.stringify([
    { label: 'Grade 3', values: { Math: 412, Reading: 398 } },
    { label: 'Grade 4', values: { Math: 430 } },
  ]);
  const result = runCli(['--type', 'bar', '--data-json', gap]);

  assert.match(result.stderr, /AGENT_FAILURE_RECORD/);
  const record = JSON.parse(
    result.stderr.slice(result.stderr.indexOf('AGENT_FAILURE_RECORD ') + 'AGENT_FAILURE_RECORD '.length)
      .split('\n')[0],
  );
  // A distinct class from ChartRenderFailed: a caller mistake and a renderer
  // bug want different fixes, so they must be told apart in agent_failures.
  assert.strictEqual(record.error_class, 'ChartInputInvalid');
  assert.match(record.error_message, /series "Reading" is missing a finite value at "Grade 4"/);
  assert.strictEqual(record.context.type, 'bar');
  assert.strictEqual(record.context.user_facing, true);
  // Exit code and wording are the contract fail() already had.
  assert.strictEqual(result.status, 2, result.stderr);
  assert.doesNotMatch(result.stderr, /unexpected error/);
});

test('an unparseable argv is still reported, with an empty context', () => {
  // parseArgs runs before there is anything to describe the run with. The
  // report goes out with a bare context rather than not at all.
  const result = runCli(['--type', 'bar', '--data-json', '[{"label":"A"']);

  assert.strictEqual(result.status, 2, result.stderr);
  assert.match(result.stderr, /AGENT_FAILURE_RECORD/);
  const record = JSON.parse(
    result.stderr.slice(result.stderr.indexOf('AGENT_FAILURE_RECORD ') + 'AGENT_FAILURE_RECORD '.length)
      .split('\n')[0],
  );
  assert.strictEqual(record.error_class, 'ChartInputInvalid');
  assert.match(record.error_message, /not valid JSON/);
});

test('a policy refusal is NOT reported as a chart failure', () => {
  // REV-INFRA-002 declining to ship PII to quickchart.io is the gate working,
  // not a defect. Filing it in agent_failures would put correct refusals in the
  // one table read to find real breakage. If these ever want recording they
  // want their own error_class, so this exclusion is asserted rather than left
  // to be re-derived from the absence of a test.
  const result = runCli([
    '--engine', 'quickchart',
    '--type', 'bar',
    '--data-json', '[{"label":"jsmith@psd401.net","value":1}]',
  ]);

  assert.strictEqual(result.status, 3, result.stderr);
  assert.doesNotMatch(result.stderr, /AGENT_FAILURE_RECORD/);
  assert.doesNotMatch(result.stderr, /unexpected error/);
});

test('category series of unequal length are refused, not misaligned', () => {
  // The draw functions zip every series against one `centres` array sized to
  // the longest, so a short series silently lands under the wrong labels.
  // run.js refuses a gap upstream; this guards the exported renderer, which is
  // called directly here and is the reusable entry point.
  assert.throws(
    () =>
      renderChartPng({
        type: 'bar',
        data: {
          labels: ['A', 'B', 'C'],
          datasets: [
            { label: 'Math', data: [1, 2, 3] },
            { label: 'Reading', data: [4, 5] },
          ],
        },
      }),
    /series lengths differ \(3, 2\)/,
  );
  // Equal lengths still render — the guard must not cost a legal chart.
  assert.ok(
    renderChartPng({
      type: 'bar',
      data: {
        labels: ['A', 'B'],
        datasets: [
          { label: 'Math', data: [1, 2] },
          { label: 'Reading', data: [3, 4] },
        ],
      },
    }).length > 0,
  );
});

test('scatter series of unequal length are legal and stay legal', () => {
  // Scatter series share only the axes, so 3 points against 2 is an ordinary
  // chart. The category guard above must not reach it.
  const png = renderChartPng({
    type: 'scatter',
    data: {
      datasets: [
        { label: 'Fall', data: [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }] },
        { label: 'Spring', data: [{ x: 1, y: 4 }, { x: 2, y: 5 }] },
      ],
    },
  });
  assert.ok(png.length > 0);
});
