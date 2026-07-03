---
name: psd-html-artifact
summary: Beautiful, anti-slop single-page HTML artifacts uploaded to S3 as a shareable link — specs, reports, dashboards, interactive editors, design explorations; optional PSD branding.
description: Generate a beautiful, self-contained single-page HTML artifact (spec, report, code-review explainer, dashboard, interactive editor, or design exploration) and return a shareable HTTPS URL. Use when asked to make an HTML page/artifact/report, turn a spec or plan into readable HTML, or build an interactive HTML editor.
allowed-tools: Bash(node:*)
---

# psd-html-artifact

Produce a single, self-contained HTML file with impeccable taste, then deliver it as a
shareable link. HTML beats Markdown for specs, reports, reviews, and explorations: it is
denser, more readable, more shareable, and people actually read it. This skill makes HTML
that does not look like a machine made it — and hands the user a URL they can open in any
browser (Google Chat renders it as a link).

This is PSD's standard artifact format: when the user asks for a spec, plan, report,
mockup, dashboard, or review writeup, default to an HTML artifact delivered by this skill
rather than a long Markdown reply.

**Identity.** Delivery requires `--user <caller-email>`. Pass the email verbatim from the
`[caller: Name <email>]` header of the user turn.

## The one rule everything serves

> If someone could look at the output and say "AI made that" without a doubt, it failed.

Recognizability over default aesthetics. Every choice below exists to defeat the
"visual maximum common denominator" of AI training data (Inter + purple gradient +
beige/brass + eyebrow-on-every-section + ghost cards). Read
`/opt/psd-skills/psd-html-artifact/references/anti-slop-bans.md` to know exactly what
those tells are and how to refuse them.

## Workflow

Run these in order. Skip nothing in steps 1, 7, and 8. All references live under
`/opt/psd-skills/psd-html-artifact/references/` and assets under
`/opt/psd-skills/psd-html-artifact/assets/`.

### 1. Emit a design read (one line, before any code)

State your interpretation so the user can correct it cheaply:

> Reading this as: `<page kind>` for `<audience>`, with a `<vibe>` language, leaning toward `<direction>`.

Examples:
- "Reading this as: an internal engineering spec for the platform team, with a calm
  document language, leaning toward a two-column reading layout with a sticky TOC."
- "Reading this as: a consumer landing page for a coffee subscription, with a warm
  editorial language, leaning toward a split hero + one saturated accent."

Infer and proceed; the user can redirect after the design read. Only ask a clarifying
question if page-kind, audience, or output format is genuinely ambiguous.

### 2. Set three dials

Infer 1–10 values from the brief; they gate downstream choices:

- `DESIGN_VARIANCE` (1 = perfect symmetry, 10 = artsy chaos)
- `MOTION_INTENSITY` (1 = static, 10 = cinematic)
- `VISUAL_DENSITY` (1 = airy, 10 = packed data)

Signal presets: minimalist/calm/editorial → ~5 / 3 / 3 · data report/dashboard → ~5 / 3 / 7 ·
marketing/agency → ~8 / 7 / 4 · public-sector/trust-first → ~3 / 2 / 5. When `DESIGN_VARIANCE > 4`,
do not use a centered hero — go split-screen, asymmetric, or left-aligned.

### 3. Pick the register and load only what you need

Always read `references/taste-core.md` and `references/anti-slop-bans.md`. Then load the
matching register reference(s) — and nothing else:

| Register | When | Reference |
|----------|------|-----------|
| Document / report | spec, plan, PR/code-review explainer, research writeup, status/incident report | `references/document-patterns.md` |
| Design / marketing | landing page, portfolio, visual identity, hero design | (taste-core + anti-slop are enough) |
| Data / dashboard | dashboard, data-rich report, analysis, KPIs, charts, data-story landing | `references/data-viz.md` + `references/dashboard-patterns.md` |
| Interactive editor | tune values, reorder/triage, annotate, export-as-prompt | `references/interactive-patterns.md` |
| Multi-variant | "give me N directions to compare" | `references/multivariant.md` |

A single task may combine registers. Load the union: a charted report pulls document-patterns
+ data-viz; a data-story landing pulls dashboard-patterns + data-viz; a dashboard with filters
adds interactive-patterns. Add interactive/variant machinery only where the task needs it. The
`assets/chart-snippets.html` scaffold has data-driven inline-SVG charts and KPI cards to copy.

### 4. Decide branding (taste-first; PSD opt-in)

Default to distinctive, brief-appropriate taste with NO district branding. Apply PSD
branding only when the user asks, or the audience is clearly PSD/internal/district
(board, staff, families, school program). When branding: follow `references/psd-branding.md`
— read real colors/fonts/logos from the bundled `psd-brand-guidelines` skill at
`/opt/psd-skills/psd-brand-guidelines/`; never AI-generate or CSS-silhouette a logo.

### 5. Gather context honestly

- **Facts first**: verify any product/version/spec/statistic before asserting it. A
  confident wrong claim is worse than a labeled unknown.
- **Real images, not fake divs**: use `psd-image-gen` for original imagery, or an honest
  labeled placeholder. A `<div>` mocked up as a fake dashboard or terminal is a tell.
- **No invented stats**: a fake-precise number (`92%`, `4.1×`) is banned unless it is
  real data or explicitly labeled as mock.

### 6. Build

Start from `assets/base-scaffold.html` (structural only — reset, a11y, reduced-motion,
print CSS, an embedded pre-flight comment). Keep everything self-contained: inline CSS,
inline vanilla JS. Fonts may load via a Google Fonts `<link>` (the file is opened from an
HTTPS URL, so the CDN link resolves in the user's browser). The file must work opened
directly by URL with no build step, no bundler, and no `<script src="local.js">`. Apply
the taste rules and the chosen aesthetic. For interactive editors, always end with an
export button ("copy as JSON / markdown / prompt") so the user can paste state back into
the agent.

**Write the file to `/tmp/`** with a short, descriptive, kebab-case filename, e.g.
`/tmp/onboarding-plan.html`. `/tmp` is writable; the skills directory is read-only.

### 7. Run the pre-flight self-audit gate

Before delivering, run every check in `references/preflight-audit.md` against the file
you just wrote (grep it). Fix every failure. Then delete the pre-flight comment block
from the scaffold. Report a one-line pass summary, e.g.:
`Audit: 1 accent locked · 2 eyebrows / 7 sections · all buttons one-line · contrast ok · reduced-motion present.`

### 8. Deliver and hand off

Upload the finished file and get a shareable URL:

```bash
node /opt/psd-skills/psd-html-artifact/deliver.js --user <email> --file /tmp/<name>.html
```

Returns JSON: `{ "url": "...", "s3Key": "public-images/.../<uuid>.html", "bytes": N, "contentType": "text/html; charset=utf-8", "sharing": "public-by-link" }`.

The URL is uploaded to the workspace S3 bucket under the public `public-images/` prefix
(same bucket policy and unguessable-UUID model as `psd-image-gen`) and is an unsigned,
public-by-link HTTPS URL that does not expire — anyone who receives it can open the page.

## Required Reply Format

After `deliver.js` returns a 2xx result, your **next chat message MUST contain the bare `url`
value on a line by itself**.

- ✅ Correct:
  ```
  Here's the spec as a page:
  https://psd-agents-dev-390844780692.s3.us-east-1.amazonaws.com/public-images/<email>/<uuid>.html
  ```
- ❌ Wrong: describing the artifact in prose without pasting the URL. The user cannot see
  the tool result — if the URL is not in your chat reply, the user got nothing.
- ❌ Wrong: wrapping the URL in `[label](url)` or `**bold**` — Google Chat's renderer
  corrupts these for long S3 URLs. Bare URL only.
- ❌ Wrong: re-uploading or presigning the returned URL. It is already public-by-link with
  HTTP 200; do not touch it.

You may add one short sentence of context above the URL line, plus the one-line audit
summary from step 7. The one real tradeoff worth noting once: HTML diffs are noisier than
Markdown, so artifacts are disposable — regenerate rather than version them.

## Hard "do not" list (full reasoning + fixes in references)

- Never `Inter`/`Roboto`/`Arial` by reflex; never `Fraunces`/`Instrument Serif` display serifs.
- Never AI-purple/violet glow gradients as a default accent.
- Never the beige/cream + brass/clay/oxblood "premium-craft" palette as a default.
- Never an eyebrow (tiny uppercase tracked label) above every section.
- Never a ghost card (`1px border` + big `box-shadow` together); never `border-radius: 32px+` on cards.
- Never em-dashes in visible copy; never marketing buzzword soup (seamless, leverage, supercharge…).
- Never serif "because it feels premium" — serif needs an explicit editorial/heritage reason.
- Never more than one accent color on a page; lock it and audit every component.

## Errors

- **`bad_args`** — missing/invalid `--user` or `--file`, non-`.html` file, empty file, or
  file over 25 MB. Fix the argument and retry.
- **`misconfigured`** — `WORKSPACE_BUCKET` env var not set. Surface to the user; do not retry.
