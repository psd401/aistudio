# Document & Report Patterns

For the register Thariq's article is really about: turning specs, plans, reviews, and
research into HTML that people actually read. Optimize for "read once, understand fully."
Pair with `taste-core.md` and `anti-slop-bans.md`.

## Shared scaffolding for any long document

- **Sticky table of contents / section nav** with smooth in-page anchors. On desktop a left
  rail; on mobile a collapsible menu. Highlight the active section (IntersectionObserver).
- **A reading measure** (65–75ch) for prose; full-width only for tables, diagrams, code.
- **Progress affordance** for long pages: a thin top scroll-progress bar or section counter.
- **Collapsible `<details>`** for appendices, long logs, and "show the full diff" — keep the
  default view scannable.
- **Responsive tables**: never let a table cause horizontal page scroll; wrap in an
  `overflow-x:auto` container or restructure to cards at narrow widths.
- **Mobile-responsive** so it reads on a phone (Thariq's point: form-factor flexibility).

## Spec / plan / implementation doc

- **Tabs or sections** for: Overview · Approach · Data flow · Risks · Open questions.
- **Mockups** of the proposed UI inline (real HTML/CSS mockups, not described in prose).
- **Data-flow / architecture as SVG**: boxes + arrows beat an ASCII diagram. Label edges.
- **Annotated code snippets** for the few bits the reader should review — syntax-highlight
  (Prism/highlight.js via CDN is fine) and add margin notes for the important lines.
- End with an **Open questions** list so the reader knows the decision points.

## Code-review / PR explainer

(Thariq attaches one of these to every PR.)

- **Render the actual diff** with inline margin annotations — not a link to GitHub.
- **Color-code by severity** (e.g. blocking / nit / question) with a legend; never rely on
  color alone (add a label or icon — accessibility).
- **Focus where asked**: if the reviewer flags one subsystem ("the backpressure logic"),
  lead with it and give it the most annotation.
- **Flowchart the tricky control flow** as SVG. Add a short "gotchas" callout for the traps.
- Keep it skimmable: a top summary of what changed and why, then the annotated detail.

## Research / explainer ("understand X")

- **Optimize for one read.** A diagram of the core mechanism (e.g. a token-bucket flow), the
  3–4 key code snippets annotated, and a **"gotchas"** section at the bottom.
- **Synthesize across sources** (codebase, git history, web, MCP data) and cite where claims
  come from. WebSearch-verify anything you are not certain of (see SKILL.md step 5).
- **SVG for every diagram**; reserve color for meaning, not decoration.

## Status / incident report (for leadership)

- **Lead with the answer**: status, impact, what changed — above the fold, no preamble.
- **Timeline** as a vertical or horizontal sequence (real sequence → numbers are earned here).
- **Metrics** as small, honest charts. No invented numbers. For anything beyond a sparkline — real charts, KPI cards, a dashboard — read `data-viz.md` and `dashboard-patterns.md`.
- **Next steps / owners** as a short table. Keep the whole thing to one screen of substance
  plus optional collapsible detail.

## Density guidance

Documents tolerate higher `VISUAL_DENSITY` than marketing pages — but density is earned by
information, not filler. Empty space is a composition tool, not a problem to fill. Do not add
a decorative icon to every heading, a stat that means nothing, or a gradient on every panel.
