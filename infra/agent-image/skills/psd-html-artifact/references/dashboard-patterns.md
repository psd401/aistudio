# Dashboard & Data-Story Patterns

The page-level layer for the data register: how to arrange charts, KPIs, narrative, and
controls. Pair with `data-viz.md` (the charts themselves), `taste-core.md`, and
`anti-slop-bans.md`. For controls/exports also read `interactive-patterns.md`.

## Pick the shape first

The same data serves three different page shapes. Decide which the brief wants.

1. **Analytical dashboard** — at-a-glance status. A KPI row across the top, then a grid of
   charts, optional filters. Optimized for monitoring and scanning.
2. **Data-story / scrollytelling landing** — a narrative that builds to a conclusion. Long
   scroll, each section pairs one chart or graphic with one claim, escalating to the takeaway.
   This is your "beautiful story laid out as a landing page with charts."
3. **Analytical report page** — read-once depth. Executive summary (the conclusion first),
   then method, findings (each finding carries its chart), recommendations, and an appendix.

Combine when needed: a report can open with a small KPI row; a data-story can end with a
dashboard. Lead with the conclusion (BLUF) in every shape — never make the reader hunt for it.

## KPI cards, done right

`anti-slop-bans.md` bans the *hero-metric cliché* (big number + gradient accent + three filler
stats). The pattern itself is fine; the cliché execution is what's banned. A real KPI card:

- The **number** (humanized), a short **label**, and the **unit** stated once.
- A **comparison that gives it meaning**: delta vs prior period or vs target ("+12% vs Q2",
  "84% of goal"), not a number floating without context.
- A **trend** the eye can read: a tiny inline sparkline or an arrow. Direction is shown by
  more than color (an arrow/sign as well), so it survives grayscale and colorblindness.
- **Real data only.** No invented precision.
- Grouped in a **restrained row**, uniform size, one accent, flat surfaces (no gradient, no
  ghost-card border+shadow, radius ≤16px). Don't nest cards.

## Layout

- **KPI row** across the top: `repeat(auto-fit, minmax(180px, 1fr))`, equal cells.
- **Chart grid / bento** below: CSS Grid with *mixed* cell sizes so the hero chart is larger
  than the supporting ones — vary size for hierarchy, don't tile identical squares. Use
  `grid-template-areas` for an intentional bento, or `repeat(auto-fit, minmax(280px, 1fr))`
  for a simple reflowing grid.
- **One accent** across the whole dashboard; charts derive their ramps from it (see data-viz).
- **Density** can run higher here (`VISUAL_DENSITY` 6–8) — but earned by information, not by
  chrome. Empty space is composition, not a gap to fill with decorative widgets.
- **Print/PDF**: dashboards are often exported. SVG charts print crisp; give a print stylesheet
  that drops controls, expands the grid to one column, and forces light backgrounds.

## Filters & controls (when interactive)

- Use a **sticky toolbar** of segmented toggles / dropdowns / a date-range. Keep it to one row.
- Re-render charts from the inline `DATA` in vanilla JS on change; no build step, `file://`-safe.
- Reflect the active view in a small **status line** ("Showing: West region · last 90 days").
- Offer a **"copy current view as prompt"** export (ties to `interactive-patterns.md`) so the
  user can paste the filtered state back into Claude.
- Every control is keyboard-accessible with visible `:focus-visible`.

## Data-story specifics

- **Each scroll section = one chart + one sentence of claim.** Build the argument; don't dump
  a chart wall. The reader should be able to read only the claims and still get the thesis.
- Reveals may animate as the section enters, but the content must be readable without JS and
  must honor `prefers-reduced-motion` (see `taste-core.md` — never ship a blank gated section).
- End with the explicit conclusion and, if it's a report, **findings → recommendations** as a
  short list with owners/next steps. Analysis without a "so what" is half-finished.

## Honesty (non-negotiable for data work)

- Verify any external figure before stating it; cite the source of the data near the charts.
- Show uncertainty where it exists (ranges, "preliminary", sample size). Don't imply precision
  the data doesn't have.
- Label missing data as missing. Never interpolate invented values to make a line look smooth.
