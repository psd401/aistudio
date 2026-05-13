---
name: psd-brand-guidelines
summary: Authoritative reference for PSD brand colors, typography, and logo files. Use whenever building branded artifacts (slides, docs, graphics) for Peninsula School District.
description: Apply Peninsula School District official brand colors, typography, and logos to artifacts including presentations, documents, graphics, and other materials. Bundles the canonical brand-config.json, the official Brand Guide PDF, and 19 PNG logo variants on disk so the agent never has to fabricate brand details.
allowed-tools: Bash(node:*)
---

# PSD Brand Guidelines Skill

This skill applies Peninsula School District's official brand identity to
artifacts: presentations, documents, graphics, web pages, and other
communications.

## CRITICAL: Enforcement Rules

### NEVER generate

**NEVER** invoke `psd-image-gen` or any image-generation tool to produce:

- District logos or emblems
- "Peninsula School District" rendered as stylized / logo text
- Bridge / landscape imagery intended to *represent* the district logo
- Any official-looking district branding elements
- District seals or official marks

**Why?** AI-generated logos hallucinate details — wrong colors, wrong name,
made-up geometry. Use the real logo files shipped with this skill.

### ALWAYS use the bundled assets

For any branded material:

1. Pick a logo file from `/opt/psd-skills/psd-brand-guidelines/assets/`
2. Pull colors from `brand-config.json` (or call `brand.js colors`)
3. Use `brand.js` to resolve the right asset for the context

## Programmatic access

The skill ships a Node CLI at `/opt/psd-skills/psd-brand-guidelines/brand.js`
with zero npm dependencies. Use it from `Bash` like any other PSD skill.

```bash
# List every brand color (name → hex)
node /opt/psd-skills/psd-brand-guidelines/brand.js colors

# Get one color's details as JSON
node /opt/psd-skills/psd-brand-guidelines/brand.js color pacific

# Resolve the right logo asset for a context
node /opt/psd-skills/psd-brand-guidelines/brand.js logo dark wide
node /opt/psd-skills/psd-brand-guidelines/brand.js logo light small

# Validate a prompt against the forbidden-generation rules
node /opt/psd-skills/psd-brand-guidelines/brand.js validate "create a PSD logo"

# Application-specific config
node /opt/psd-skills/psd-brand-guidelines/brand.js application presentations
node /opt/psd-skills/psd-brand-guidelines/brand.js application documents
node /opt/psd-skills/psd-brand-guidelines/brand.js application digital

# Typography
node /opt/psd-skills/psd-brand-guidelines/brand.js typography
```

`logo` arguments:

| Argument | Values | Notes |
|----------|--------|-------|
| `bg`     | `light` \| `medium` \| `dark` | `dark` → white knockout logo |
| `space`  | `wide` \| `square` \| `vertical` \| `small` | `wide` → fulllandscape or horizontal |

## Reference data

The full brand guide PDF is bundled:

```
/opt/psd-skills/psd-brand-guidelines/assets/PSD_Branding_Guide.pdf
```

## Typography

### Headings & logo text: Josefin Sans

Modern geometric, elegant font with a 1920s feel. **Bold** weight for the
district name and headings.

- **Font:** Josefin Sans Bold
- **Source:** https://fonts.google.com/specimen/Josefin+Sans
- **Fallback:** Arial, sans-serif

### Body text: Josefin Slab

Slab serif paired to Josefin Sans, highly legible at smaller sizes.

- **Font:** Josefin Slab Regular
- **Source:** https://fonts.google.com/specimen/Josefin+Slab
- **Fallback:** Georgia, serif

## Color palette

### Primary (logo colors)

| Name | Hex | RGB | Usage |
|------|-----|-----|-------|
| **Sea Glass** | `#6CA18A` | rgb(108, 161, 138) | Primary green, landscape elements |
| **Pacific**   | `#25424C` | rgb(37, 66, 76)    | Primary dark blue, text, headers |
| **Driftwood** | `#D7CDBE` | rgb(215, 205, 190) | Neutral tan, backgrounds |

### Supporting

| Name | Hex | RGB | Usage |
|------|-----|-----|-------|
| **Cedar**     | `#466857` | rgb(70, 104, 87)  | Dark green accent |
| **Whulge**    | `#346780` | rgb(52, 103, 128) | Medium blue (Coast Salish word for sound of waves), links |
| **Sea Foam**  | `#EEEBE4` | rgb(238, 235, 228) | Light background |
| **Meadow**    | `#5D9068` | rgb(93, 144, 104) | Green accent |
| **Ocean**     | `#7396A9` | rgb(115, 150, 169) | Light blue accent |
| **Skylight**  | `#FFFAEC` | rgb(255, 250, 236) | Off-white/cream background, text on dark |

### Color selection guidelines

- **Light backgrounds:** Pacific (`#25424C`) text or 2-color logo
- **Dark backgrounds:** Sea Glass (`#6CA18A`) text or white-knockout logo
- **Neutral backgrounds:** choose for contrast; lean Pacific Northwest tones

## Logo files

### Available layouts

| Layout | Description | Best for |
|--------|-------------|----------|
| **fulllandscape** | Bridge connecting peninsula landscape, district name inside | letterheads, wide spaces |
| **horizontal**    | Compact horizontal lockup | headers, footers, constrained widths |
| **stacked**       | Vertical layout, name below brandmark | vertical spaces, social profiles |
| **emblem**        | Round brandmark only | small sizes, avatars, icons |
| **square**        | Square format | social media, square containers |

### Color variants

- **2color** — Sea Glass + Pacific (primary use)
- **1color-blue** — Pacific only
- **1color-green** — Sea Glass only
- **white** — knockout for dark backgrounds (no fulllandscape variant)

### Files on disk

All logos ship as PNG at `/opt/psd-skills/psd-brand-guidelines/assets/`:

```
psd_logo-2color-{emblem,fulllandscape,stacked,horizontal,square}.png
psd_logo-1color-blue-{emblem,fulllandscape,stacked,horizontal,square}.png
psd_logo-1color-green-{emblem,fulllandscape,stacked,horizontal,square}.png
psd_logo-white-{emblem,stacked,horizontal,square}.png
```

For print-quality vector files (EPS) contact the brand owner — those are
not bundled in the agent image to keep its size down.

## Logo usage rules

### Do
- Maintain original proportions
- Ensure sufficient contrast with the background
- Pick the color variant that matches the background
- Use emblem or stacked for small sizes

### Don't
- Shrink fulllandscape below 1.5in print / 300px web
- Rotate the logo
- Apply drop shadows, mirroring, or other effects
- Stretch or squish
- Pair with non-brand fonts
- Place on insufficient-contrast backgrounds

## Applying brand to artifacts

### Presentations

```css
/* Title slides */
background-color: #25424C;  /* Pacific */
color:            #FFFAEC;  /* Skylight */
font-family:      'Josefin Sans', Arial, sans-serif;

/* Content slides */
background-color: #EEEBE4;  /* Sea Foam */
color:            #25424C;  /* Pacific */
font-family:      'Josefin Slab', Georgia, serif;

/* Accent borders */
border-color:     #6CA18A;  /* Sea Glass */
```

Title slides: use the **white horizontal** logo bottom-right.
Content slides: use the **2color emblem** logo bottom-right.

### Documents

- **Headings:** Josefin Sans Bold, Pacific (`#25424C`)
- **Body:** Josefin Slab Regular, Pacific (`#25424C`)
- **Links / highlights:** Whulge (`#346780`)
- **Backgrounds:** Sea Foam (`#EEEBE4`) or Skylight (`#FFFAEC`)

### Digital / web

- Primary button: Sea Glass (`#6CA18A`)
- Secondary button: Whulge (`#346780`)
- Text on light: Pacific (`#25424C`)
- Text on dark: Skylight (`#FFFAEC`)

## Brand contact

For questions or special requests:

- **Danielle Chastaine**, Digital Media Coordinator
- chastained@psd401.net

## Quick reference (JS literal)

```javascript
const PSD_BRAND = {
  colors: {
    seaGlass:  '#6CA18A',
    pacific:   '#25424C',
    driftwood: '#D7CDBE',
    cedar:     '#466857',
    whulge:    '#346780',
    seaFoam:   '#EEEBE4',
    meadow:    '#5D9068',
    ocean:     '#7396A9',
    skylight:  '#FFFAEC',
  },
  fonts: {
    heading: "'Josefin Sans', Arial, sans-serif",
    body:    "'Josefin Slab', Georgia, serif",
  },
  logoDir: '/opt/psd-skills/psd-brand-guidelines/assets/',
};
```

---

*Source: PSD Branding Guide and `brand-config.json`. Ported from
`psd401/psd-claude-plugins/plugins/psd-productivity/skills/psd-brand-guidelines`
on 2026-05-12.*
