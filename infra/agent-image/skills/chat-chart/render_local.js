'use strict';

/**
 * render_local.js — chat-chart's on-host (local) render engine.
 *
 * Rasterises the Chart.js-shaped config produced by run.js into a PNG,
 * entirely in-process with Node built-ins (`node:zlib` for the deflate
 * stream; everything else is hand-rolled here).
 *
 * WHY NOT matplotlib: the previous local engine shelled out to
 * render_local.py and needed matplotlib in /opt/agentcore-venv plus an
 * npm install for the S3 upload. Both were pulled after the 2026-05-18
 * incident, where AgentCore's Firecracker snapshotter failed to mount the
 * image overlay and every microVM died with "Failed to mount overlay: No
 * such file or directory" — a failure the build has since hit from two
 * directions: a `__pycache__/` written beside render_local.py carrying
 * macOS xattrs into the layer (now fenced off by .dockerignore) and, on
 * 2026-07-02, simply crossing the 54-layer ceiling. With the local engine
 * gone, QuickChart was the only reachable engine, so chat-chart had to
 * refuse every --sensitive request rather than ship district data to
 * quickchart.io (issue #1596).
 *
 * A pure-Node renderer sidesteps both failure modes by construction: no
 * Python file to leave a bytecode cache next to, and no npm install to
 * spend a layer on.
 *
 * This renderer reinstates the local engine with ZERO new image weight:
 * no pip dependency, no npm dependency, no new Dockerfile RUN, no new
 * layer. It is installed by the existing `COPY skills /opt/psd-skills`.
 *
 * Rendering model: draw into an RGB byte buffer at 2x the output size,
 * then box-downsample. That supersample is the only anti-aliasing —
 * cheap, dependency-free, and good enough for a Chat-sized card image.
 *
 * The supported surface deliberately mirrors what run.js can emit:
 *
 *     type:        bar | line | pie | scatter
 *     data.labels: [str, ...]          (bar / line / pie)
 *     data.datasets[0].data:
 *         bar/line/pie: [number, ...]
 *         scatter:      [{ "x": number, "y": number }, ...]
 *     options.plugins.title.text: optional title string
 *
 * Extending this surface should match a parallel extension in run.js so
 * the two engines stay symmetric.
 */

const zlib = require('node:zlib');

// Output geometry. Device space is SUPERSAMPLE x the emitted image; every
// drawing helper below works in device pixels.
const SUPERSAMPLE = 2;
const OUT_WIDTH = 800;
const OUT_HEIGHT = 500;
const DEVICE_WIDTH = OUT_WIDTH * SUPERSAMPLE;
const DEVICE_HEIGHT = OUT_HEIGHT * SUPERSAMPLE;

const TITLE_SCALE = 6;
const LABEL_SCALE = 4;
const TICK_SCALE = 3;

const MARGIN = { left: 190, right: 60, top: 60, bottom: 150 };
const TITLE_HEIGHT = 90;

const WHITE = [255, 255, 255];
const TEXT = [33, 33, 33];
const AXIS = [90, 90, 90];
const GRID = [219, 219, 219];

// Categorical palette (tab10-derived). Series colour cycles through it for
// bar/pie; line/scatter use the first entry.
const PALETTE = [
  [31, 119, 180],
  [214, 39, 40],
  [44, 160, 44],
  [255, 127, 14],
  [148, 103, 189],
  [23, 190, 207],
  [227, 119, 194],
  [140, 86, 75],
  [127, 127, 127],
  [188, 189, 34],
];

const MAX_POINTS = 50;

/**
 * 5x7 bitmap font, ASCII 32..126. Each glyph is five columns; each column
 * is one byte whose bit N (0 = top) lights row N. Public-domain glcd-style
 * table — the same one used by countless embedded 5x7 renderers.
 */
const FONT_5X7 = [
  '0000000000', // (space)
  '0000005F00', // !
  '0007000700', // "
  '147F147F14', // #
  '242A7F2A12', // $
  '2313086462', // %
  '3649552250', // &
  '0000050300', // '
  '001C224100', // (
  '0041221C00', // )
  '14083E0814', // *
  '08083E0808', // +
  '0000503000', // ,
  '0808080808', // -
  '0000606000', // .
  '2010080402', // /
  '3E5149453E', // 0
  '00427F4000', // 1
  '4261514946', // 2
  '2141454B31', // 3
  '1814127F10', // 4
  '2745454539', // 5
  '3C4A494930', // 6
  '0171090503', // 7
  '3649494936', // 8
  '064949291E', // 9
  '0036360000', // :
  '0056360000', // ;
  '0814224100', // <
  '1414141414', // =
  '0041221408', // >
  '0201510906', // ?
  '324979413E', // @
  '7E1111117E', // A
  '7F49494936', // B
  '3E41414122', // C
  '7F4141221C', // D
  '7F49494941', // E
  '7F09090901', // F
  '3E4149497A', // G
  '7F0808087F', // H
  '00417F4100', // I
  '2040413F01', // J
  '7F08142241', // K
  '7F40404040', // L
  '7F020C027F', // M
  '7F0408107F', // N
  '3E4141413E', // O
  '7F09090906', // P
  '3E4151215E', // Q
  '7F09192946', // R
  '4649494931', // S
  '01017F0101', // T
  '3F4040403F', // U
  '1F2040201F', // V
  '3F4038403F', // W
  '6314081463', // X
  '0708700807', // Y
  '6151494543', // Z
  '007F414100', // [
  '0204081020', // (backslash)
  '0041417F00', // ]
  '0402010204', // ^
  '4040404040', // _
  '0001020400', // `
  '2054545478', // a
  '7F48444438', // b
  '3844444420', // c
  '384444487F', // d
  '3854545418', // e
  '087E090102', // f
  '0C5252523E', // g
  '7F08040478', // h
  '00447D4000', // i
  '2040443D00', // j
  '7F10284400', // k
  '00417F4000', // l
  '7C04180478', // m
  '7C08040478', // n
  '3844444438', // o
  '7C14141408', // p
  '081414187C', // q
  '7C08040408', // r
  '4854545420', // s
  '043F444020', // t
  '3C4040207C', // u
  '1C2040201C', // v
  '3C4030403C', // w
  '4428102844', // x
  '0C5050503C', // y
  '4464544C44', // z
  '0008364100', // {
  '00007F0000', // |
  '0041360800', // }
  '08082A1C08', // ~
];

const FONT_WIDTH = 5;
const FONT_HEIGHT = 7;
const FONT_ADVANCE = FONT_WIDTH + 1;
const FIRST_GLYPH = 32;
const LAST_GLYPH = 126;
const FALLBACK_GLYPH = '?'.codePointAt(0);

let crcTable = null;

function getCrcTable() {
  if (crcTable) return crcTable;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xED_B8_83_20 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  crcTable = table;
  return crcTable;
}

function crc32(buffer) {
  const table = getCrcTable();
  let crc = -1;
  for (const byte of buffer) {
    crc = table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** Encode an RGB byte buffer (3 bytes/px, row-major) as a PNG. */
function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const from = y * stride;
    raw[y * (stride + 1)] = 0; // filter type: none
    rgb.copy(raw, y * (stride + 1) + 1, from, from + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createCanvas(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 3, 0xFF) };
}

function setPixel(canvas, x, y, colour) {
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
  const offset = (y * canvas.width + x) * 3;
  canvas.data[offset] = colour[0];
  canvas.data[offset + 1] = colour[1];
  canvas.data[offset + 2] = colour[2];
}

function fillRect(canvas, rect, colour) {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const x1 = Math.min(canvas.width, Math.round(rect.x + rect.width));
  const y1 = Math.min(canvas.height, Math.round(rect.y + rect.height));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      setPixel(canvas, px, py, colour);
    }
  }
}

function drawLineSegment(canvas, from, to, colour, thickness = 2) {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y), 1);
  const half = Math.floor(thickness / 2);
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    const px = Math.round(from.x + (to.x - from.x) * t);
    const py = Math.round(from.y + (to.y - from.y) * t);
    fillRect(
      canvas,
      { x: px - half, y: py - half, width: thickness, height: thickness },
      colour,
    );
  }
}

function fillCircle(canvas, cx, cy, radius, colour) {
  const r2 = radius * radius;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= r2) {
        setPixel(canvas, Math.round(cx + dx), Math.round(cy + dy), colour);
      }
    }
  }
}

function glyphColumns(codePoint) {
  const point =
    codePoint >= FIRST_GLYPH && codePoint <= LAST_GLYPH ? codePoint : FALLBACK_GLYPH;
  const hex = FONT_5X7[point - FIRST_GLYPH];
  const columns = [];
  for (let i = 0; i < FONT_WIDTH; i++) {
    columns.push(Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));
  }
  return columns;
}

function drawGlyph(canvas, codePoint, position, colour) {
  const { x, y, scale } = position;
  const columns = glyphColumns(codePoint);
  for (const [col, bits] of columns.entries()) {
    for (let row = 0; row < FONT_HEIGHT; row++) {
      if ((bits >> row) & 1) {
        fillRect(
          canvas,
          { x: x + col * scale, y: y + row * scale, width: scale, height: scale },
          colour,
        );
      }
    }
  }
}

function textWidth(text, scale) {
  return text.length === 0 ? 0 : (text.length * FONT_ADVANCE - 1) * scale;
}

/**
 * Draw ASCII text. `align` positions the string relative to `x`
 * ('left' | 'center' | 'right'); `y` is always the glyph top.
 */
function drawText(canvas, text, position, colour) {
  const { x, y, scale, align = 'left' } = position;
  let cursor = x;
  if (align === 'center') cursor = x - textWidth(text, scale) / 2;
  if (align === 'right') cursor = x - textWidth(text, scale);
  for (const char of text) {
    drawGlyph(canvas, char.codePointAt(0), { x: Math.round(cursor), y, scale }, colour);
    cursor += FONT_ADVANCE * scale;
  }
}

function averageBlock(canvas, x0, y0, factor) {
  let r = 0;
  let g = 0;
  let b = 0;
  for (let dy = 0; dy < factor; dy++) {
    for (let dx = 0; dx < factor; dx++) {
      const offset = ((y0 + dy) * canvas.width + (x0 + dx)) * 3;
      r += canvas.data[offset];
      g += canvas.data[offset + 1];
      b += canvas.data[offset + 2];
    }
  }
  const count = factor * factor;
  return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
}

function downsample(canvas, factor) {
  const width = Math.floor(canvas.width / factor);
  const height = Math.floor(canvas.height / factor);
  const out = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = averageBlock(canvas, x * factor, y * factor, factor);
      const offset = (y * width + x) * 3;
      out[offset] = r;
      out[offset + 1] = g;
      out[offset + 2] = b;
    }
  }
  return { width, height, data: out };
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return '';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (magnitude >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
  if (Number.isInteger(value)) return String(value);
  if (magnitude >= 10) return value.toFixed(1);
  if (magnitude >= 1) return value.toFixed(2);
  return String(Number.parseFloat(value.toFixed(4)));
}

/** ASCII-only sanitisation: the bitmap font has no glyphs beyond 126. */
function toAsciiLabel(value) {
  const text = String(value ?? '');
  let out = '';
  for (const char of text) {
    const point = char.codePointAt(0);
    out += point >= FIRST_GLYPH && point <= LAST_GLYPH ? char : '?';
  }
  return out;
}

function truncateLabel(label, maxChars) {
  if (maxChars < 1) return '';
  if (label.length <= maxChars) return label;
  return `${label.slice(0, Math.max(1, maxChars - 1))}.`;
}

/** 1/2/5 x 10^k tick steps covering [min, max] in ~`target` divisions. */
function niceTicks(min, max, target = 5) {
  const span = max - min || Math.abs(max) || 1;
  const rawStep = span / target;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalised = rawStep / magnitude;
  let step = magnitude;
  if (normalised > 5) step = 10 * magnitude;
  else if (normalised > 2) step = 5 * magnitude;
  else if (normalised > 1) step = 2 * magnitude;
  const start = Math.floor(min / step) * step;
  // A flat series (min === max) lands start on end, which would yield a
  // single tick and a zero-height axis. Always leave at least one division.
  const end = Math.max(Math.ceil(max / step) * step, start + step);
  const ticks = [];
  for (let value = start; value <= end + step / 2; value += step) {
    ticks.push(Number.parseFloat(value.toFixed(10)));
  }
  return ticks;
}

function plotArea(hasTitle) {
  const top = MARGIN.top + (hasTitle ? TITLE_HEIGHT : 0);
  return {
    left: MARGIN.left,
    top,
    right: DEVICE_WIDTH - MARGIN.right,
    bottom: DEVICE_HEIGHT - MARGIN.bottom,
    width: DEVICE_WIDTH - MARGIN.right - MARGIN.left,
    height: DEVICE_HEIGHT - MARGIN.bottom - top,
  };
}

function drawTitle(canvas, title) {
  if (!title) return;
  drawText(canvas, truncateLabel(toAsciiLabel(title), 52), {
    x: DEVICE_WIDTH / 2,
    y: MARGIN.top,
    scale: TITLE_SCALE,
    align: 'center',
  }, TEXT);
}

/** Horizontal gridlines + y tick labels + the two axis rules. */
function drawValueAxis(canvas, area, ticks) {
  const min = ticks[0];
  const max = ticks.at(-1);
  const toY = value => area.bottom - ((value - min) / (max - min || 1)) * area.height;
  for (const tick of ticks) {
    const y = toY(tick);
    fillRect(canvas, { x: area.left, y, width: area.width, height: 2 }, GRID);
    drawText(canvas, formatNumber(tick), {
      x: area.left - 20,
      y: y - (FONT_HEIGHT * TICK_SCALE) / 2,
      scale: TICK_SCALE,
      align: 'right',
    }, TEXT);
  }
  fillRect(canvas, { x: area.left, y: area.top, width: 2, height: area.height }, AXIS);
  fillRect(canvas, { x: area.left, y: area.bottom, width: area.width, height: 2 }, AXIS);
  return toY;
}

// Thinning below this many categories reads as "the renderer lost a label",
// so few-category charts truncate instead.
const MIN_THINNED_CATEGORIES = 7;
// Beyond this, a label is too long to be worth widening the stride for.
const MAX_LABEL_CHARS = 12;

/**
 * Decide how to letter the category axis: which font scale, how many
 * characters each label gets, and whether to label every Nth category.
 *
 * Preference order matters more than it looks. Truncation destroys exactly
 * the part of a label that distinguishes it ("2026-05-01" and "2026-05-14"
 * both truncate to "202."), so a dense axis keeps WHOLE labels and shows
 * fewer of them — the way a printed axis does — rather than a row of stubs.
 */
function categoryLabelPlan(labels, slotWidth) {
  const longest = Math.max(...labels.map(label => label.length));
  for (const scale of [LABEL_SCALE, TICK_SCALE]) {
    const maxChars = Math.floor(slotWidth / (FONT_ADVANCE * scale));
    if (maxChars >= longest) return { scale, maxChars, stride: 1 };
  }
  const scale = TICK_SCALE;
  if (labels.length < MIN_THINNED_CATEGORIES) {
    return { scale, maxChars: Math.floor(slotWidth / (FONT_ADVANCE * scale)), stride: 1 };
  }
  const wanted = Math.min(longest, MAX_LABEL_CHARS) + 1;
  const stride = Math.max(2, Math.ceil((FONT_ADVANCE * scale * wanted) / slotWidth));
  const maxChars = Math.max(
    1,
    Math.floor((slotWidth * stride) / (FONT_ADVANCE * scale)) - 1,
  );
  return { scale, maxChars, stride };
}

function drawCategoryLabels(canvas, labels, area, slotWidth, centres) {
  const { scale, maxChars, stride } = categoryLabelPlan(labels, slotWidth);
  for (const [index, label] of labels.entries()) {
    if (index % stride !== 0) continue;
    drawText(canvas, truncateLabel(label, maxChars), {
      x: centres[index],
      y: area.bottom + 24,
      scale,
      align: 'center',
    }, TEXT);
  }
}

/**
 * Bars are read as areas, so their axis must include zero or the picture
 * lies about relative size. Lines/scatter are read as trends, so they keep
 * the data's own range — forcing zero flattens series like a 0.94-0.96
 * attendance rate into a straight line.
 */
function valueRange(values, { includeZero }) {
  const min = includeZero ? Math.min(...values, 0) : Math.min(...values);
  const max = includeZero ? Math.max(...values, 0) : Math.max(...values);
  return min === max ? { min, max: max + 1 } : { min, max };
}

function drawBarChart(canvas, labels, values, area) {
  const { min, max } = valueRange(values, { includeZero: true });
  const ticks = niceTicks(min, max);
  const toY = drawValueAxis(canvas, area, ticks);
  const slot = area.width / values.length;
  const barWidth = slot * 0.62;
  const zeroY = toY(0);
  const centres = values.map((_, index) => area.left + slot * (index + 0.5));
  for (const [index, value] of values.entries()) {
    const y = toY(value);
    const top = Math.min(y, zeroY);
    const height = Math.max(Math.abs(y - zeroY), 2);
    const colour = PALETTE[index % PALETTE.length];
    fillRect(
      canvas,
      { x: centres[index] - barWidth / 2, y: top, width: barWidth, height },
      colour,
    );
    // Value labels are a bonus, not the chart. Drop them rather than let
    // neighbouring bars' numbers overprint each other, and put a negative
    // bar's label under it so the text never sits on top of the bar.
    if (textWidth(formatNumber(value), TICK_SCALE) <= slot) {
      drawText(canvas, formatNumber(value), {
        x: centres[index],
        y: value < 0 ? top + height + 10 : top - FONT_HEIGHT * TICK_SCALE - 10,
        scale: TICK_SCALE,
        align: 'center',
      }, TEXT);
    }
  }
  drawCategoryLabels(canvas, labels, area, slot, centres);
}

function drawLineChart(canvas, labels, values, area) {
  const { min, max } = valueRange(values, { includeZero: false });
  const ticks = niceTicks(min, max);
  const toY = drawValueAxis(canvas, area, ticks);
  const slot = area.width / values.length;
  const centres = values.map((_, index) => area.left + slot * (index + 0.5));
  const colour = PALETTE[0];
  for (const [index, value] of values.entries()) {
    if (index > 0) {
      drawLineSegment(
        canvas,
        { x: centres[index - 1], y: toY(values[index - 1]) },
        { x: centres[index], y: toY(value) },
        colour,
        6,
      );
    }
  }
  for (const [index, value] of values.entries()) {
    fillCircle(canvas, centres[index], toY(value), 8, colour);
  }
  drawCategoryLabels(canvas, labels, area, slot, centres);
}

function drawScatterChart(canvas, points, area) {
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const yTicks = niceTicks(Math.min(...ys), Math.max(...ys));
  const toY = drawValueAxis(canvas, area, yTicks);
  const xTicks = niceTicks(Math.min(...xs), Math.max(...xs));
  const xMin = xTicks[0];
  const xMax = xTicks.at(-1);
  const toX = value => area.left + ((value - xMin) / (xMax - xMin || 1)) * area.width;
  for (const tick of xTicks) {
    const x = toX(tick);
    fillRect(canvas, { x, y: area.top, width: 2, height: area.height }, GRID);
    drawText(canvas, formatNumber(tick), {
      x,
      y: area.bottom + 24,
      scale: TICK_SCALE,
      align: 'center',
    }, TEXT);
  }
  fillRect(canvas, { x: area.left, y: area.bottom, width: area.width, height: 2 }, AXIS);
  for (const point of points) {
    fillCircle(canvas, toX(point.x), toY(point.y), 9, PALETTE[0]);
  }
}

function wedgeColour(dx, dy, radius, bounds) {
  if (dx * dx + dy * dy > radius * radius) return null;
  let angle = Math.atan2(dy, dx);
  if (angle < 0) angle += 2 * Math.PI;
  const found = bounds.find(bound => angle >= bound.start && angle < bound.end);
  return found ? found.colour : null;
}

function wedgeBounds(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  let cursor = 0;
  return values.map((value, index) => {
    const sweep = (value / total) * 2 * Math.PI;
    const bound = {
      start: cursor,
      end: index === values.length - 1 ? 2 * Math.PI : cursor + sweep,
      colour: PALETTE[index % PALETTE.length],
      share: value / total,
    };
    cursor += sweep;
    return bound;
  });
}

function drawPieLegend(canvas, labels, bounds, x, top) {
  const rowHeight = 46;
  for (const [index, label] of labels.entries()) {
    const y = top + index * rowHeight;
    fillRect(canvas, { x, y, width: 28, height: 28 }, bounds[index].colour);
    const percent = `${Math.round(bounds[index].share * 100)}%`;
    drawText(canvas, `${truncateLabel(label, 20)} ${percent}`, {
      x: x + 44,
      y: y + 2,
      scale: TICK_SCALE,
    }, TEXT);
  }
}

function drawPieChart(canvas, labels, values, area) {
  if (values.some(value => value < 0)) {
    throw new Error('pie charts need non-negative values');
  }
  if (values.reduce((sum, value) => sum + value, 0) <= 0) {
    throw new Error('pie chart values must sum to a positive number');
  }
  const bounds = wedgeBounds(values);
  const radius = Math.floor(Math.min(area.height, area.width * 0.5) / 2);
  const cx = area.left + radius + 20;
  const cy = area.top + area.height / 2;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const colour = wedgeColour(dx, dy, radius, bounds);
      if (colour) setPixel(canvas, Math.round(cx + dx), Math.round(cy + dy), colour);
    }
  }
  const legendTop = Math.max(area.top, cy - (labels.length * 46) / 2);
  drawPieLegend(canvas, labels, bounds, cx + radius + 60, legendTop);
}

function readSeries(config) {
  const data = config?.data ?? {};
  const datasets = Array.isArray(data.datasets) ? data.datasets : [];
  if (datasets.length === 0) throw new Error('config.data.datasets is empty');
  const series = Array.isArray(datasets[0].data) ? datasets[0].data : [];
  if (series.length === 0) throw new Error('config.data.datasets[0].data is empty');
  if (series.length > MAX_POINTS) {
    throw new Error(`too many data points (${series.length} > ${MAX_POINTS})`);
  }
  return series;
}

function readLabels(data, count) {
  const labels = Array.isArray(data?.labels) ? data.labels : [];
  return Array.from({ length: count }, (_, index) =>
    toAsciiLabel(labels[index] ?? String(index + 1)),
  );
}

function readNumbers(series) {
  return series.map(value => {
    if (!Number.isFinite(value)) {
      throw new TypeError(`non-numeric data point: ${JSON.stringify(value)}`);
    }
    return value;
  });
}

function readPoints(series) {
  return series.map(point => {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
      throw new TypeError(`scatter points need numeric x/y: ${JSON.stringify(point)}`);
    }
    return { x: point.x, y: point.y };
  });
}

function drawChart(canvas, config, area) {
  const series = readSeries(config);
  const type = config?.type;
  if (type === 'scatter') {
    drawScatterChart(canvas, readPoints(series), area);
    return;
  }
  const values = readNumbers(series);
  const labels = readLabels(config.data, values.length);
  if (type === 'bar') drawBarChart(canvas, labels, values, area);
  else if (type === 'line') drawLineChart(canvas, labels, values, area);
  else if (type === 'pie') drawPieChart(canvas, labels, values, area);
  else throw new Error(`unsupported chart type: ${JSON.stringify(type)}`);
}

/**
 * Render a Chart.js-shaped config to PNG bytes. Throws (never exits) so
 * callers can decide how to surface the failure.
 */
function renderChartPng(config) {
  const title = config?.options?.plugins?.title?.text;
  const canvas = createCanvas(DEVICE_WIDTH, DEVICE_HEIGHT);
  fillRect(canvas, { x: 0, y: 0, width: DEVICE_WIDTH, height: DEVICE_HEIGHT }, WHITE);
  drawTitle(canvas, title);
  drawChart(canvas, config, plotArea(Boolean(title)));
  const out = downsample(canvas, SUPERSAMPLE);
  return encodePng(out.width, out.height, out.data);
}

module.exports = {
  renderChartPng,
  // Exported for unit tests.
  categoryLabelPlan,
  encodePng,
  formatNumber,
  niceTicks,
  toAsciiLabel,
  truncateLabel,
  OUT_WIDTH,
  OUT_HEIGHT,
};
