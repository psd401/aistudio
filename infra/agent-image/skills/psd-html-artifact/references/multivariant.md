# Multi-Variant Explorations

When the user is not sure of the direction, do not pick one and commit silently. Generate
several distinctly different directions in a single HTML file so they can compare side by side
and tell you which to pursue. This is one of the highest-value uses of HTML (Thariq: "6 distinct
onboarding approaches in a grid").

## How to do it well

- **3–6 directions**, genuinely different — vary **layout, tone, and density**, not just the
  accent color. Two variants that differ only in hue is a failure.
- **Pull from different style families**, not three flavors of the same idea: e.g. calm
  editorial · dense dashboard · bold marketing · minimalist. Never ship 2+ from one family.
- **Label every variant** with the tradeoff it makes ("Direction B — densest; best for power
  users, weakest first impression"). The label is the point; it makes the comparison decidable.
- **Use the user's real content**, not Lorem ipsum, so the comparison is honest.
- Each variant gets enough fidelity to judge — a real hero, real type, real spacing — not a
  greybox.

## Two layouts for the comparison page

1. **Static grid** (default for pure visual comparison): each variant in its own framed cell,
   laid out in a responsive grid, all visible at once. A short caption under each with its
   tradeoff. No interaction needed — the user scans and picks.
2. **Tabbed / full-width switch** (when each variant is large or interactive): a tab strip or
   prev/next control that swaps the full-width variant, with the tradeoff shown alongside.

## After they pick

Offer to expand the chosen direction into a full artifact, and to **graft** specific elements
from the runners-up ("keep B's layout but A's type"). Each variant should be self-contained
enough that pulling one out is trivial.

## Taste still applies

Every variant obeys `taste-core.md` and `anti-slop-bans.md`. Distinct directions are the
goal; sloppy ones are not. If a direction can only be made distinct by reaching for a banned
tell, it is not a real direction — replace it.
