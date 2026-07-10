# Taste Core

The always-on craft rules. Read this for every artifact, in any register. Pair it with
`anti-slop-bans.md` (what to refuse). These are synthesized from impeccable, taste-skill,
ui-ux-pro-max, and huashu-design.

## Principle

One detail at 120%, the rest at 80%. Taste is tactical concentration, not uniform effort.
Pick the one screenshot-worthy moment (a headline treatment, a single chart, a hero image)
and make it exceptional; let everything else be quiet and correct.

## Typography

- **Scale by contrast, not flatness.** Use a modular scale with ≥1.25 ratio between steps.
  Hierarchy comes from scale + weight contrast, not from five near-identical sizes.
- **≤3 families** (display + body + optional mono). More reads as indecision.
- **Pair on a contrast axis** (serif × sans, geometric × humanist) or use one family across
  weights. Never pair two similar-but-not-identical sans-serifs.
- **Body measure 65–75ch.** Wider is unreadable; much narrower fragments prose.
- **`text-wrap: balance`** on h1–h3, **`text-wrap: pretty`** on long prose.
- **Display ceiling ~6rem** (`clamp()` max). Above that the page is shouting. Letter-spacing
  floor on display ≥ -0.04em or letters touch.
- **No all-caps body copy.** Uppercase only for short labels (≤4 words) and badges.
- **Emphasis inside a headline** = italic/bold of the *same* family. Never inject a stray
  serif word into a sans headline.
- **Italic descender clearance**: italic display words with `y g j p q` need ≥1.1 line-height
  and a little bottom padding, or the descender clips. Audit every italic display word.
- **Serif is discouraged as a default.** "Feels creative/premium" is not a reason. Use serif
  only when the brief is genuinely editorial / luxury / publication / heritage and you can say
  why this serif fits this brand.

### Font pairings to rotate (so output does not converge)

Do not default to one pairing across artifacts. Rotate; pick what fits the brief's voice.
None of these are the banned reflex fonts.

- **Modern neutral**: Geist + Geist (weights) · or Söhne-like grotesk + a humanist body.
- **Editorial (when justified)**: a display serif (e.g. GT Sectra, Reckless, Canela, EB
  Garamond for body) × a clean grotesk for UI.
- **Warm humanist**: Fraunces is banned; reach for a humanist sans (e.g. Hanken Grotesk,
  Bricolage Grotesque as display) + readable body.
- **Technical/mono accent**: a grotesk display + JetBrains Mono / Geist Mono for code & labels.
- **PSD branded**: Josefin Sans (headings) + Josefin Slab (body) — see `psd-branding.md`.

If you reach for a font by reflex, stop and pick from voice, not habit.

## Color

- **Use OKLCH** for defining and mixing color; it keeps lightness perceptually even.
- **One accent, locked.** Choose a single accent and use it on the WHOLE page. A warm-grey
  site does not suddenly get a blue CTA in section 7. Audit every component before shipping.
- **60-30-10**: dominant neutral / secondary / accent. Tinted neutrals beat pure grey — add
  0.005–0.015 chroma toward the accent's hue rather than defaulting warm or cool.
- **Pick a strategy up front:**
  - *Restrained* — tinted neutrals + one accent ≤10%. Default for documents/product UI.
  - *Committed* — one saturated color carries 30–60% of the surface. Identity-driven pages.
  - *Full palette* — 3–4 named roles, each used deliberately. Data viz, campaigns.
  - *Drenched* — the surface IS the color. Brand heroes only.
- **Contrast is non-negotiable**: body ≥4.5:1; large text (≥18px, or bold ≥14px) ≥3:1;
  placeholder text also needs 4.5:1. Gray text on a colored background looks washed out — use
  a darker shade of the background's own hue or a transparency of the text color.

## Layout & spacing

- **Flex for 1D, Grid for 2D.** Don't default to Grid where `flex-wrap` is simpler.
- **Responsive grids without breakpoints**: `repeat(auto-fit, minmax(280px, 1fr))`.
- **Vary spacing for rhythm**; a single uniform gap everywhere reads as a wireframe.
- **Cards are the lazy answer.** Use them only when they're the best affordance. Nested cards
  are always wrong.
- **Semantic z-index scale** (dropdown → sticky → backdrop → modal → toast → tooltip). Never
  arbitrary `9999`.
- **Anti-center bias** when `DESIGN_VARIANCE > 4`: split-screen, left-aligned content +
  right asset, or asymmetric whitespace instead of a centered hero. Centered hero is fine for
  editorial/manifesto/announcement pages where the message is the design.
- **Hero fits the first viewport**: headline ≤2 lines, subtext ≤20 words and ≤4 lines, CTA
  visible without scrolling. A 4-line hero headline is a font-size error, not a copy problem.
  Hero top padding ≤ ~6rem. Plan font size and asset size together.

## Motion

- **Motion must be motivated.** Before adding any animation, name what it communicates:
  hierarchy, sequence/storytelling, feedback, or state change. "It looked cool" → drop it.
- **Ease out** with exponential curves (ease-out-quart/quint/expo). No bounce, no elastic,
  no `linear`/`ease-in-out` defaults on premium work — use a custom cubic-bezier.
- **`prefers-reduced-motion` is mandatory.** Every animation needs a reduce alternative
  (crossfade or instant). The scaffold ships the guard; keep it.
- **Reveals must enhance an already-visible default.** Never gate content visibility on a
  class-triggered transition; on hidden tabs / headless renderers the reveal never fires and
  the section ships blank.
- **One well-orchestrated page-load** (staggered reveals via `animation-delay`) delights more
  than scattered micro-interactions. Marquees: at most one per page.

## Copy

- **Every word earns its place.** No restated headings, no intro that repeats the title.
- **No em-dashes** in visible copy (and not `--` either). Use commas, colons, periods,
  parentheses.
- **No marketing buzzwords**: streamline, empower, supercharge, leverage, unleash, transform,
  seamless, world-class, enterprise-grade, next-generation, cutting-edge, game-changer.
- **No aphoristic cadence** as a default voice ("serious statement, then punchy negation").
- **Buttons = verb + object**: "Save changes" beats "OK"; "Delete project" beats "Yes".
- **Links stand alone**: "View pricing plans" beats "Click here".
- **One label per intent.** Don't mix "Get in touch" / "Contact us" / "Let's talk" on one
  page — pick one and reuse it (nav, hero, footer).
