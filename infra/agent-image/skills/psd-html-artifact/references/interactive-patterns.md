# Interactive Editor Patterns

Sometimes the best output is a throwaway, purpose-built editor for one piece of data — not a
product, not a reusable tool, just a single HTML file for this one task. The defining move is
the **export**: the UI always ends with a button that turns what the user did back into
something they can paste into Claude Code.

Constraints (always): self-contained, vanilla JS, no build step, no `<script src="local">`.
It must work opened via `file://`. Pair with `taste-core.md` + `anti-slop-bans.md`.

## The export rule (non-negotiable)

Every interactive artifact ends with one or more of:

- **Copy as JSON** — the structured state.
- **Copy as Markdown** — a human-readable summary (e.g. ordering + a one-line rationale).
- **Copy as prompt** — a ready-to-paste instruction back to Claude ("Apply this ordering:…").

Use the async clipboard API with a fallback, and give visible confirmation:

```js
async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch { const t = document.createElement('textarea'); t.value = text;
          document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove(); }
  const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => btn.textContent = old, 1200);
}
```

## Common shapes

### Tune values (sliders / knobs)
For animation timing, easing, colors, spacing, easing curves, crop regions — anything painful
to describe in text. Show a **live preview** that updates on input, plus a **copy parameters**
button. Example uses: "try options on this button animation," "pick the easing curve."

### Reorder / triage / bucket
Draggable cards across columns (Now / Next / Later / Cut), or a sortable list. Pre-sort by your
best guess so the user edits rather than starts cold. Export the final order with a one-line
rationale per bucket. Use the native HTML Drag and Drop API or pointer events; keep it
keyboard-accessible (move-up/move-down buttons as a fallback).

### Structured-config editor
A form for feature flags / env vars / JSON-with-constraints. Group by area, show dependencies,
warn when a toggle's prerequisite is off. Export a **diff** of only the changed keys.

### Side-by-side / live template
Editable input on the left, rendered result on the right that re-renders live. Good for tuning
a prompt or copy: highlight variable slots, show a character/token counter, copy button.

### Annotate
Load a document/transcript/diff, let the user highlight and comment, export the annotations as
structured data.

### Curate a dataset
Approve/reject/tag rows; export the selection.

## Taste still applies

An editor is not an excuse for slop. One locked accent, real type, motivated motion, contrast
on every control. Make the one interaction that matters feel good (the drag, the slider, the
copy confirmation) and keep the chrome quiet.
