# Anti-Slop Bans

The named tells that make HTML read as machine-made, why each one is slop, and the fix.
Slop is not "ugly" — it is the visual maximum common denominator of AI training data, which
means it carries zero brand signal. The user asked you to make *their* thing recognizable;
defaulting to the common denominator betrays that.

Every ban has an override: if the brief explicitly calls for the thing, do it with intent.
The ban is on the *reflex*, not the technique.

## Fonts — reflex-reject list

Do not reach for these by default. They are the training-data favorites; they read "demo,"
not "designed."

- **Sans defaults**: Inter, Roboto, Arial, system-ui as the *chosen* face, DM Sans, Plus
  Jakarta Sans, Outfit, Space Grotesk.
- **Display serifs**: Fraunces, Instrument Serif (the two most over-used), Playfair Display,
  Cormorant, Newsreader, Lora, Crimson.
- **Mono clichés**: Space Mono as a personality choice.

Override: a brief that names the font, or a public-sector/accessibility-first brief where
neutral system fonts are correct. Otherwise pick from voice — see the rotation list in
`taste-core.md`.

## Color — banned default palettes

### The AI-purple / violet glow ("Lila rule")
Purple/violet button glows and neon gradient meshes are the SaaS/AI/web3 default. **Fix:**
neutral base (zinc/slate/stone, tinted) + one high-contrast accent (emerald, electric blue,
deep rose, burnt orange). Override: brand explicitly is purple — then execute it consistently,
not as generic gradient slop.

### The beige/cream + brass premium-craft palette
The default reach for "premium consumer / artisan / wellness / heritage" briefs. Every such
site ships this exact palette, so the brand goes invisible. **Banned as a default:**
- Backgrounds: `#f5f1ea`, `#f7f5f1`, `#fbf8f1`, `#efeae0`, `#ece6db`, `#faf7f1`, `#e8dfcb`
- Accents (brass/clay/oxblood/ochre): `#b08947`, `#b6553a`, `#9a2436`, `#9c6e2a`, `#bc7c3a`, `#7d5621`
- Text (espresso near-black): `#1a1714`, `#1a1814`, `#1b1814`

**Rotate to instead** (pick a *different* one each time; never ship the same one twice in a row):
cold luxury (silver-grey + chrome), forest (deep green + bone + amber), black & tan (off-black
+ warm tan, no beige), cobalt + cream, terracotta + slate, olive + brick + paper, or pure
monochrome + one saturated pop.

Token names are tells too: `--paper`, `--cream`, `--sand`, `--bone`, `--linen`, `--parchment`.

## Layout & component tells

- **Ghost card**: `border: 1px solid` + `box-shadow: 0 …px …px` (blur ≥16px) on the same
  element. Pick one, never both.
- **Over-rounding**: `border-radius: 32px+` on cards/sections/inputs. Cards top out at 12–16px.
- **Side-stripe accent**: a colored `border-left`/`border-right` >1px as decoration. Never
  intentional.
- **Gradient text**: `background-clip: text` + gradient. Decorative, meaningless.
- **Glassmorphism by default**: blur/glass cards used everywhere. Rare and purposeful, or none.
- **Eyebrow spam**: a tiny uppercase wide-tracked label (`text-[11px] uppercase tracking-[.2em]`)
  above *every* section header. **Hard rule: ≤ ceil(sectionCount / 3) eyebrows per page** (hero
  counts as one). If section A has one, the next two cannot. Usually: drop it; the headline and
  the section's position already categorize it.
- **Numbered-section grammar**: "01 / 02 / 03" above every section. Numbers earn their place
  only when the section is genuinely a sequence.
- **Zigzag overuse**: alternating left-image/right-text then right-image/left-text. **Max 2 in
  a row**; break with a full-width, vertical-stack, or bento section.
- **Split-header filler**: big left headline + small right explainer paragraph as a section
  header, where the right column is just text. Stack them vertically instead (max-width 65ch).
  Use the split only when the right column carries a real visual/interactive element.
- **Identical card grids**: same-size icon + heading + text cards repeated endlessly.
- **Hero-metric template**: big number, small label, gradient accent, three supporting stats. *(This bans the cliché execution, not KPI cards — a real dashboard KPI carries comparison context plus a trend and uses no gradient. See `dashboard-patterns.md`.)*
- **Hand-drawn / sketchy SVG** (class names like `doodle`, `wavy`, `loose-sketch`;
  `feTurbulence`). Reads amateur, not whimsical.
- **`repeating-linear-gradient` diagonal stripes** in a body background. Pure decoration.
- **Div-based fake screenshots**: a "product preview" built from `<div>` rectangles, fake task
  lists, fake terminals. Use a real screenshot, a generated image, a real mini-component, or
  skip it. (See step 5 in SKILL.md on images.)
- **Logo wall with labels**: a social-proof logo row with category labels under each logo. The
  logo is the credibility; drop the labels.

## Copy tells

- **Em-dashes** as a design flourish — banned (see taste-core).
- **"X theater" / "not just X" / "actually X"** constructions ("productivity theater"): instant
  AI voice. Cut.
- **Fake-precise numbers** (`92%`, `4.1×`, `48k`) that are invented spec-aesthetics. Real data
  or labeled mock only.
- **AI-cute copy**: forced metaphors, fake-craftsman labels, mock-poetic micro-meta, passive-
  aggressive humility. If a string sounds like an LLM trying to sound thoughtful, replace it
  with a plain functional sentence. Boring beats cute-but-wrong.

## How to use this file

When auditing (step 7), grep the generated file for the literal tells: `Inter`, `Fraunces`,
`Instrument`, the banned hex values, `border-radius: 32px`, `repeating-linear-gradient`,
`—`/`--` in copy, `tracking-[` count vs section count. Any hit must be justified by the brief
or fixed.
