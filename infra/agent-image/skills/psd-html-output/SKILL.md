---
name: psd-html-output
summary: Bias artifact generation toward HTML — richer layout, interactivity, and information density than Markdown. Prompt-only guide, no code.
---

# HTML Output — Default Artifact Format

Markdown is fine for short conversational replies. For **artifacts** — specs, plans, reports, mockups, dashboards, review writeups — default to HTML. HTML gives you CSS layout, SVG diagrams, native tables, embedded interactivity (sliders, toggles, copy buttons), and mobile-responsive design. Markdown caps out at flat text.

This skill is a guide, not a framework. There is no `/html` command, no build step, no templating system. You already know how to write HTML. This skill tells you **when** to reach for it and **how** to make it good.

---

## When to use HTML

Default to HTML for these artifact types:

| Artifact type | Why HTML wins |
|---|---|
| Specs and implementation plans | Collapsible sections, linked headings, severity color-coding, embedded diagrams |
| Design mockups and prototypes | CSS layout, animation playgrounds, sliders + copy-as-prompt buttons |
| Reports, research, status updates | SVG flowcharts, data tables with sorting, color-coded metrics |
| Code review writeups | Rendered diffs with margin annotations, severity badges, inline links to lines |
| Incident/postmortem reports | Timelines with color bands, severity indicators, collapsible root-cause trees |
| Brainstorming and exploration | Side-by-side comparisons, weighted scorecards, interactive pros/cons |
| Custom throwaway UIs | Drag-and-drop reorder, feature-flag editor, prompt tuner with side-by-side preview |

## When NOT to use HTML

Keep Markdown (or plain Chat text) for:

- **Short conversational replies** — Chat formatting per `psd-rules` Rule 6. A two-line answer stays in Chat.
- **In-repo files** — `CLAUDE.md`, `README.md`, `SOUL.md`, daily logs (`memory/YYYY-MM-DD.md`). These must be diffable in git; HTML diffs are noisy.
- **Anything that lives in git long-term** — PRs review diffs line-by-line. HTML is hostile to `git diff`.
- **Simple lists or quick lookups** — if the answer is three bullet points, don't wrap it in `<html>`.

**Rule of thumb:** If the output is >50 lines and has any structure beyond flat bullets, HTML is probably the right call. If it's <10 lines of text, stay in Chat.

---

## How to make HTML good

### Layout and structure

- Use semantic HTML: `<section>`, `<details>`, `<summary>`, `<table>`, `<nav>`.
- CSS for all layout — no inline `style` soup. Put a single `<style>` block in `<head>`.
- Mobile-responsive: use `max-width`, `margin: 0 auto`, and media queries. The user may read on a phone.
- Dark/light mode: respect `prefers-color-scheme` via CSS media query. Default to a neutral light theme.

### Diagrams and visuals

- **SVG for diagrams** — flowcharts, architecture diagrams, timelines. Inline SVG in the HTML body.
- **Native HTML `<table>`** for tabular data — not ASCII art, not Markdown pipe tables.
- **CSS color-coding** for status/severity: green/yellow/red or similar accessible palette.

### Interactivity

- For interactive artifacts (design exploration, prompt tuning, config editors): include JavaScript directly in the HTML file.
- Add a **"Copy as prompt"** or **"Copy as JSON"** button that exports the current state as paste-ready text. Include brief visual feedback (e.g., changing button text to "Copied!") upon success. This is the key interaction pattern — the user tweaks something visually, then copies the result back into a prompt.
- Keep JS minimal and dependency-free. No CDN imports, no build tools. Vanilla JS only.
- **Sanitize user-provided text** before embedding it in the HTML. Escape `<`, `>`, `&`, `"`, and `'` as HTML entities (`&lt;`, `&gt;`, `&amp;`, `&quot;`, `&#39;`). This prevents accidental script injection when artifact content includes user input such as project names, PR titles, or search queries.

### Self-contained

- Every HTML artifact must be a **single file** that opens in any browser with no server.
- No external CSS/JS dependencies. No CDN links. Everything inline.
- Images: use inline SVG. Avoid base64 data URIs as they are token-intensive and prone to corruption; use them only for tiny icons if SVG is unavailable.
- Include a **Content Security Policy** meta tag in `<head>`: `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:;">`. This blocks external resource loading (CDN scripts, remote images, fetch calls) but does **not** prevent inline script injection — that protection comes from the HTML-entity-escaping rule above. The CSP enforces the self-contained constraint; the sanitization rule handles XSS.

### Links

- For any `<a>` links with `target="_blank"`, always include `rel="noopener noreferrer"` to prevent reverse tabnabbing in older browsers.

---

## Where to save HTML artifacts

Write generated HTML files to:

```
~/.openclaw/canvas/<descriptive-name>-<YYYY-MM-DD>.html
```

Examples:
- `~/.openclaw/canvas/onboarding-plan-2026-05-09.html`
- `~/.openclaw/canvas/api-review-writeup-2026-05-09.html`
- `~/.openclaw/canvas/budget-dashboard-2026-05-09.html`

Use the Pacific date from `[now:]`. Use lowercase kebab-case for the descriptive name. The `~/.openclaw/canvas/` directory is already established for agent-generated canvases (per SOUL.md).

After writing the file, tell the user the path so they can open it in their browser.

---

## Trade-offs to communicate

When generating HTML instead of Markdown, note these trade-offs if the user hasn't seen them before:

- **Speed:** HTML generation is 2-4x slower than Markdown. For a large spec this may add 30-60 seconds.
- **Token usage:** HTML is more verbose than Markdown. Not a practical concern with current context limits, but worth knowing.
- **Diffability:** HTML artifacts should not be committed to git for long-term tracking. They are disposable — regenerate rather than diff.

You don't need to repeat these warnings every time. Mention them once on first HTML generation in a session, then move on.

---

## Example prompts

These are the kinds of requests where you should produce HTML output by default:

**Spec / implementation plan:**
> "Write up the implementation plan for the new notification system."
> Produce an HTML document with collapsible sections per component, a dependency diagram in SVG, a risk matrix as a color-coded table, and a timeline.

**Design exploration:**
> "Show me three layout options for the dashboard sidebar."
> Produce an HTML file with three side-by-side mockups using CSS, each with a "Copy as prompt" button that exports the layout config.

**Code review writeup:**
> "Write a review summary for PR #842."
> Produce an HTML document with rendered diff snippets, margin annotations for each finding, severity badges (critical/warning/info), and inline links to the relevant lines.

---

## Conflict resolution with psd-rules

This skill and `psd-rules` both govern output format. The boundary is clear:

- **`psd-rules` Rule 6** governs Chat messages (the conversational reply). That stays as Google Chat-compatible Markdown.
- **`psd-html-output`** governs artifacts written to files. When you produce an artifact (spec, plan, report, mockup), write it as HTML to `~/.openclaw/canvas/`.

A single turn can have both: a short Chat reply ("Here's the implementation plan") and an HTML artifact saved to disk. The Chat reply references the file path; the artifact itself is HTML.
