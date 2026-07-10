# PSD Branding (opt-in)

Default is taste-first with no district branding. Apply PSD branding only when:

- the user explicitly asks for it ("PSD branded", "district style", "on-brand"), **or**
- the audience is clearly Peninsula School District — board, staff, families, a school
  program, an internal district report.

When in doubt, ask, or default to unbranded.

## Get the real brand data (do not hardcode from memory)

Skills cannot invoke other skills, so read the bundled `psd-brand-guidelines` skill's files
directly. In this container every skill lives flat under `/opt/psd-skills/`, so the brand
skill is at `/opt/psd-skills/psd-brand-guidelines/`.

- **Colors / fonts / logo rules**: `/opt/psd-skills/psd-brand-guidelines/brand-config.json` (machine-readable).
- **Logo files**: `/opt/psd-skills/psd-brand-guidelines/assets/` (PNG for web).
- **Helper** (optional, zero-dependency Node CLI): `node /opt/psd-skills/psd-brand-guidelines/brand.js colors`
  and `node /opt/psd-skills/psd-brand-guidelines/brand.js logo <light|medium|dark> <wide|square|vertical|small>`.

To embed a logo in a self-contained artifact, base64-inline the chosen PNG from the assets
directory (read the file, `data:image/png;base64,...`) so the page stays shareable as one file.

Always read `brand-config.json` for the authoritative values rather than copying the table
below; the values here are a convenience snapshot and may drift.

## Snapshot (verify against brand-config.json)

**Fonts** — load via Google Fonts:
- Headings & logo text: **Josefin Sans** (Bold). Fallback `Arial, sans-serif`.
- Body: **Josefin Slab**. Fallback `Georgia, serif`.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Josefin+Sans:wght@400;700&family=Josefin+Slab:wght@400;600&display=swap" rel="stylesheet">
```

**Colors** (Pacific Northwest / Puget Sound palette):

| Name | Hex | Role |
|------|-----|------|
| Sea Glass | `#6CA18A` | primary green / primary buttons |
| Pacific | `#25424C` | primary dark blue / text / headers |
| Driftwood | `#D7CDBE` | neutral tan / backgrounds |
| Cedar | `#466857` | dark green accent |
| Whulge | `#346780` | medium blue / links, secondary buttons |
| Sea Foam | `#EEEBE4` | light background |
| Meadow | `#5D9068` | green accent |
| Ocean | `#7396A9` | light blue accent |
| Skylight | `#FFFAEC` | off-white / cream background |

Role guidance:
- Light backgrounds → text in Pacific (`#25424C`); accents in Sea Glass.
- Dark backgrounds (Pacific) → text in Skylight (`#FFFAEC`); logo = white variant.
- Primary button Sea Glass; secondary Whulge; links Whulge.
- Backgrounds: Sea Foam or Skylight.

Note: PSD's palette IS the brand — when branded, the "one locked accent" rule relaxes into
this defined multi-role palette. Still keep contrast ≥4.5:1 (verify Sea Glass text/buttons).

## Logos — hard rules

- **Never AI-generate, never CSS-silhouette, never recreate** the logo, the district name as
  stylized text, or bridge/landscape marks. Use an actual file from `assets/`.
- Pick the variant by background and space:
  - Light bg → `psd_logo-2color-horizontal.png` (or `-stacked` / `-emblem` for tight space).
  - Dark bg → `psd_logo-white-horizontal.png` (or `-emblem`).
- Embed by copying the chosen PNG next to the output file and referencing it relatively, or
  inline as a base64 data URI so the artifact stays self-contained and shareable.
- Don't rotate, stretch, recolor, add effects, or place on a low-contrast background. Don't
  shrink the full landscape logo below ~300px wide on web (use emblem/stacked when small).

Brand questions: Danielle Chastaine, Digital Media Coordinator — chastained@psd401.net.
