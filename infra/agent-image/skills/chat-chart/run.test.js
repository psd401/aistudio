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
const zlib = require('node:zlib');

const { chooseEngine, buildChartJsConfig } = require('./run.js');
const {
  renderChartPng,
  formatNumber,
  niceTicks,
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

test('each chunk carries a correct CRC32', () => {
  const png = renderChartPng(BAR_CONFIG);
  assert.strictEqual(typeof zlib.crc32, 'function', 'zlib.crc32 is the oracle here');
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const declared = png.readUInt32BE(offset + 8 + length);
    const actual = zlib.crc32(png.subarray(offset + 4, offset + 8 + length));
    assert.strictEqual(actual, declared, `CRC at offset ${offset}`);
    offset += length + 12;
  }
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

function countNonWhite(pixels) {
  let count = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    if (pixels[i] !== 255 || pixels[i + 1] !== 255 || pixels[i + 2] !== 255) count++;
  }
  return count;
}

const INK_SAMPLES = {
  bar: [
    { label: 'Mon', value: 12 },
    { label: 'Tue', value: 8 },
  ],
  line: [
    { label: '2026-05-12', value: 0.94 },
    { label: '2026-05-13', value: 0.95 },
  ],
  pie: [
    { label: 'Meets', value: 38 },
    { label: 'Below', value: 62 },
  ],
  scatter: [
    { x: 1, y: 2 },
    { x: 3, y: 9 },
  ],
};

for (const [type, data] of Object.entries(INK_SAMPLES)) {
  test(`${type} charts render ink on the canvas`, () => {
    const png = renderChartPng(buildChartJsConfig(type, data, `${type} title`));
    const inked = countNonWhite(decodePixels(png));
    assert.ok(inked > 2000, `${type} chart only inked ${inked} pixels`);
  });
}

test('bar charts paint the series colour, not just axis furniture', () => {
  const png = renderChartPng(buildChartJsConfig('bar', [{ label: 'A', value: 10 }], null));
  const pixels = decodePixels(png);
  let seriesBlue = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    if (pixels[i] === 31 && pixels[i + 1] === 119 && pixels[i + 2] === 180) seriesBlue++;
  }
  assert.ok(seriesBlue > 1000, `expected a filled bar, saw ${seriesBlue} px`);
});

test('rendering is deterministic for identical input', () => {
  const a = renderChartPng(BAR_CONFIG);
  const b = renderChartPng(BAR_CONFIG);
  assert.ok(a.equals(b));
});

test('a chart with no title still renders', () => {
  const png = renderChartPng(buildChartJsConfig('bar', [{ label: 'A', value: 1 }], null));
  assert.strictEqual(parsePngChunks(png)[0].data.readUInt32BE(4), OUT_HEIGHT);
});

test('negative bar values render against a zero baseline', () => {
  const png = renderChartPng(
    buildChartJsConfig(
      'bar',
      [
        { label: 'Down', value: -4 },
        { label: 'Up', value: 6 },
      ],
      'Change',
    ),
  );
  assert.ok(countNonWhite(decodePixels(png)) > 2000);
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

test('more points than the documented ceiling is rejected, not truncated', () => {
  const data = Array.from({ length: 51 }, (_, i) => ({ label: `L${i}`, value: i }));
  assert.throws(
    () => renderChartPng(buildChartJsConfig('bar', data, 'too many')),
    /too many data points/,
  );
});

test('missing labels fall back to ordinal positions', () => {
  const png = renderChartPng({
    type: 'bar',
    data: { datasets: [{ data: [1, 2, 3] }] },
    options: {},
  });
  assert.ok(countNonWhite(decodePixels(png)) > 2000);
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
});

test('axis numbers stay short and readable', () => {
  assert.strictEqual(formatNumber(12), '12');
  assert.strictEqual(formatNumber(0.94), '0.94');
  assert.strictEqual(formatNumber(1234.5), '1234.5');
  assert.strictEqual(formatNumber(25_000), '25.0k');
  assert.strictEqual(formatNumber(3_400_000), '3.4M');
  assert.strictEqual(formatNumber(Number.NaN), '');
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
