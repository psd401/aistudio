# Data Visualization

For the data register: self-contained dashboards, data-rich reports, and data-story pages.
This file covers the data and the charts; `dashboard-patterns.md` covers the page layout
around them. Always pair with `taste-core.md` and `anti-slop-bans.md`.

The goal: charts that are beautiful, honest, self-contained, and that each say one thing.

## Self-contained data (always inline)

The dataset travels inside the file. Never fetch from a URL/API unless the brief explicitly
requires live data (it breaks single-file portability — say so if you do it).

```html
<script type="application/json" id="data">
{ "revenue": [{"month":"Jan","value":42000}, {"month":"Feb","value":51000}] }
</script>
<script>
  const DATA = JSON.parse(document.getElementById('data').textContent);
</script>
```

- Inline the *real* data you were given. Do not invent rows or fabricate precision; a
  fake-precise number is banned (see `anti-slop-bans.md`). If data is missing, show an honest
  gap and label it.
- Charts read from `DATA` so the file is one portable artifact and the numbers are auditable.

## Choosing how to render (hybrid rule)

**Hand-build inline SVG by default.** It gives full taste control, zero dependencies, prints
crisp, and works fully offline. Use it for: bar/column, line, area, sparkline, donut/arc,
simple scatter, bullet charts, and small multiples. The `assets/chart-snippets.html` scaffold
has data-driven SVG bar + line + sparkline + KPI patterns to copy.

**Reach for a CDN library only when the chart is genuinely complex or interactive** — dense
time series, many series with zoom/brush, cross-filtering, maps, or large datasets. Tasteful,
`file://`-safe choices (loaded via CDN `<script>`/ESM):

| Library | Use it for | Note |
|---------|-----------|------|
| Observable Plot | concise statistical charts with good defaults | least config, great taste baseline |
| uPlot | dense time series, thousands of points | tiny, very fast |
| ECharts | rich interactive dashboards, many chart types | heavier; powerful |
| Chart.js | quick standard charts | easy; restyle away from defaults |
| D3 | bespoke / novel visualizations | most effort, most control |

When you use a library: still apply every chart-taste rule below, still inline the data, and
remember a CDN dependency needs network when the file is opened. Avoid full dashboard
frameworks — they convert a portable artifact into an app.

## Chart-taste rules (what separates a real chart from a default one)

- **One chart, one message.** Each chart points at a single takeaway. Annotate it — a callout,
  a highlighted bar, a reference/target line — so the reader gets the point without decoding.
- **Direct-label, don't legend.** With ≤4 series, label them at the line ends or on the bars.
  Reserve a legend for many small series. Axis labels and titles are real text, not images.
- **Honest baselines.** Bars and areas start at zero. Lines may use a non-zero baseline only
  when the change is the point — and then label the range so it can't mislead. Never truncate
  an axis to exaggerate.
- **Restrained grid.** Light horizontal gridlines at human intervals; drop vertical gridlines
  and chart borders/boxes. Maximize data-ink; remove everything that isn't data or a needed
  reference.
- **Color with meaning, from the accent.** Build a sequential ramp by stepping OKLCH lightness
  on the locked accent hue; categorical palettes cap at ~5–6 distinguishable hues. No rainbow,
  no gradient fills for decoration. **Color is never the only encoding** — pair it with a
  label, position, or pattern so it survives colorblindness and grayscale print.
- **No chartjunk.** No 3D, no bar drop-shadows, no dual y-axes without a compelling reason, no
  pie/donut beyond ~5 slices (use a bar), no decorative gradients behind plots.
- **Format numbers like a human.** Humanize magnitudes (1.2k, 3.4M), keep decimals consistent,
  state the unit once (axis or title), right-align numeric table columns.
- **Motion is motivated.** A short on-load draw/grow is fine if it aids reading; it must be
  gated behind `prefers-reduced-motion: no-preference` and the chart must be fully readable
  static (never gate the data behind an animation that may not fire — see `taste-core.md`).
- **Responsive.** Use `viewBox` + `preserveAspectRatio` so SVG scales; reduce tick density on
  narrow screens; let chart grids reflow with `repeat(auto-fit, minmax())`.

## Accessibility (required)

- Give each chart a text **title** and a one-sentence **takeaway** near it.
- Add `role="img"` and an `aria-label` that states the takeaway and key numbers, OR include a
  visually-hidden `<table>` of the underlying data as a fallback for screen readers.
- Interactive tooltips must be keyboard-reachable and show the exact value; never make a value
  available *only* on hover.

## Tables (the other half of analysis)

Dense tabular data is legitimate and often clearer than a chart. Make it scannable: sticky
header, right-aligned numbers, zebra or hairline row separators (not heavy borders), inline
sparklines or bar cells for trends, sortable columns when interactive. Never let a table force
horizontal page scroll — wrap in `overflow-x:auto` or restructure to cards on mobile.
