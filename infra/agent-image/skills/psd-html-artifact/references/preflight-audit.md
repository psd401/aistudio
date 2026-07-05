# Pre-Flight Self-Audit Gate

Run this against the file you just wrote, before delivering. It is mechanical on purpose:
grep the file, count, verify. Any failure is fixed, not rationalized. Then delete the
pre-flight comment block from the scaffold and report a one-line pass summary.

A failure here is broken work, not a style preference.

## Typography
- [ ] **No banned fonts** as the chosen face. Grep: `Inter`, `Roboto`, `Fraunces`, `Instrument`,
      `Space Grotesk`, `DM Sans`. Any hit must be brief-justified (e.g. PSD brand, public-sector).
- [ ] Body text uses a 65–75ch measure; no wall-to-wall prose.
- [ ] Display headings ≤ ~6rem; italic display words with descenders don't clip.

## Color
- [ ] **Exactly one accent**, used across the whole page. No stray second accent in a late
      section or the footer.
- [ ] **Not the banned beige+brass palette** as a default. Grep the banned hex list in
      `anti-slop-bans.md`. Not an AI-purple glow gradient unless the brief names purple.
- [ ] Contrast: body ≥4.5:1, large text ≥3:1, placeholders ≥4.5:1. Check every button's
      text-on-background, including ghost buttons over images (need a scrim/stroke).

## Layout
- [ ] **Eyebrow count ≤ ceil(sectionCount / 3).** Grep `uppercase` + `tracking`/`letter-spacing`
      on labels; count vs section count.
- [ ] If `DESIGN_VARIANCE > 4`, the hero is **not** centered.
- [ ] **Hero fits the first viewport**: headline ≤2 lines, subtext ≤20 words / ≤4 lines, CTA
      above the fold. Hero top padding ≤ ~6rem.
- [ ] **No ghost cards** (`border` + heavy `box-shadow` together). No `border-radius: 32px+` on
      cards. No side-stripe accent borders.
- [ ] **Zigzag image+text splits ≤2 in a row.** No identical-card-grid sprawl.
- [ ] **Nav on one line** at desktop, height ≤ ~80px.
- [ ] Responsive with no horizontal overflow at **375 / 768 / 1024 / 1440**.

## Buttons & CTAs
- [ ] Every button's label fits **one line** at desktop (primary CTAs ≤3 words).
- [ ] **One label per intent** across the page (no "Get in touch" + "Contact us" + "Let's talk").

## Copy
- [ ] **No em-dashes** (or `--`) in visible copy.
- [ ] No marketing buzzword soup; no "X theater" / "not just X" constructions.
- [ ] **No invented fake-precise numbers** — real data or labeled mock only.
- [ ] Re-read every visible string: no broken grammar, unclear referents, or AI-cute filler.

## Images & assets
- [ ] Images are real (tool-generated / real URL / honest labeled placeholder) — **no fake
      `<div>` screenshots**. No hand-drawn `feTurbulence`/doodle SVG unless the brief asks.
- [ ] All meaningful images have `alt` text. Logo (if any) is a real file, never AI-generated.

## Data & charts (data register only)
- [ ] Dataset is **inlined** in the file (no fetch unless the brief required live data).
- [ ] **No invented or fake-precise numbers** — every figure is real data or labeled mock; sources cited.
- [ ] Bars/areas start at a **zero baseline**; any non-zero line axis is labeled, not misleading.
- [ ] **Color is not the only encoding** (labels/arrows/position too); chart palette derives from the one accent; readable in grayscale.
- [ ] No chartjunk: no 3D, no bar shadows, no dual y-axis without reason, no pie/donut beyond ~5 slices.
- [ ] Each chart has a **title + one-sentence takeaway** and a `role="img"` aria-label (or a hidden data-table fallback).
- [ ] KPI cards carry **comparison context + trend** and use no gradient (not the banned hero-metric cliché).
- [ ] Chart entrance animation (if any) is gated behind `prefers-reduced-motion` and the chart reads fully static.

## Motion & a11y
- [ ] **`prefers-reduced-motion`** alternative present for every animation (scaffold guard kept).
- [ ] Reveal animations enhance an already-visible default (content is not gated behind a class
      that may never fire).
- [ ] `:focus-visible` states exist for keyboard nav.
- [ ] At most one marquee on the page.

## Self-containment
- [ ] Single file: inline CSS, inline vanilla JS, fonts via CDN `<link>`. No `<script src>` to a
      local file. Opens and works via `file://`.
- [ ] The scaffold's pre-flight comment block has been **deleted** from the delivered file.

## Pass summary (report to the user)

Example: `Audit pass — 1 accent locked · 2 eyebrows / 8 sections · all buttons one-line ·
contrast ok · reduced-motion present · self-contained, opens on file://.`
