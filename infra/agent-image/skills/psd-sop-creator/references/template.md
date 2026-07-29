# PSD Standard Operations Template

Transcribed from the official district template, *PSD - Standard Operations
Template*. This is the authority on **structure**; `writing-guide.md` is the
authority on **content**.

## What the paper template looks like

A single page, in this order:

1. The two-color district logo, top left.
2. The heading **Standard Operating Procedure (SOP)**, to the right of the logo.
3. Seven labelled fields, each on its own line, in this exact order:

```
Title:
Scope:
Procedure:
Safety Considerations:
Quality Control:
References:
Revision History:
```

There is nothing else. No cover page, no numbering, no footer text.

## The markdown the skill expects

`run.js` injects the logo, the `# Standard Operating Procedure (SOP)` heading,
and the metadata block. **You supply the body, starting at `## Title`.** Do not
write the logo or the H1 yourself — `create` rejects a body that already has one,
because it would be duplicated.

```markdown
## Title

Printer & Copier Allocation, Upkeep & Maintenance

## Scope

All schools and administrative buildings

## Procedure

To reduce costs and provide equitable access to print and copy services, all
schools will be allocated printers and copiers based on a formula.

1. Determine the building type.
2. Apply the allocation for that type.
3. Route any exception through the Technology Department before purchase.

## Safety Considerations

All maintenance to printers and copiers will only be done by district technology
staff or vendors hired by the district.

## Quality Control

Building Leadership Teams (BLTs) determine printer locations in collaboration
with the building administrator.

## References

- PSD Print Analysis Dashboard
- ESD 112 Print Center

## Revision History

- Created: 06/20/2023 - KH
```

## Required sections

All seven, as level-2 (`##`) headings, spelled exactly as below, in exactly this
relative order. `run.js validate` fails with exit 3 and a per-section list if any
is missing, misspelled, or out of order.

| # | Heading |
|---|---------|
| 1 | `## Title` |
| 2 | `## Scope` |
| 3 | `## Procedure` |
| 4 | `## Safety Considerations` |
| 5 | `## Quality Control` |
| 6 | `## References` |
| 7 | `## Revision History` |

Every required section must have content. An empty section fails validation —
write `N/A` (and only when it is genuinely not applicable) rather than leaving it
blank.

## Optional sections

Not in the paper template, but present in real district SOPs when complexity
warrants. Each may appear **at most once**, and only in the position below.
Anything else is rejected as an unknown section, so a typo in a required heading
surfaces as an error instead of being silently accepted as an extra section.

| Heading | Position | Use when |
|---------|----------|----------|
| `## Purpose` | after Title | the "why" is not obvious from the title |
| `## Definitions` | after Scope | 3+ specialized terms need defining |
| `## Compliance` | after Procedure | specific legal compliance requirements exist |
| `## Contact` | after Quality Control | a named person is the go-to |
| `## Addendum` | after Revision History | severity charts, flowcharts, supplemental forms |
| `## Glossary` | after Addendum | disciplinary or legal terms need defining |

## Metadata

`create` injects a metadata block below the H1 from its flags. You do not write
it. Required: `--owner`, `--department`, `--effective-date`. `--department` must
be one of:

```
Athletics & Activities
Teaching and Learning
Employee Support Services
Communications and Public Relations
Safety and Security
Finance and Operations
Technology
Governance and Leadership
```

Gather these from the user **before** drafting. If any is unknown, ask — do not
invent an owner or a date.

## Formatting rules the storage layer imposes

These are not style preferences. Content that breaks them is lost, so `validate`
refuses it.

- **Markdown only. No raw HTML.** The editor-seeding path drops raw HTML tokens
  outright (`markdown-bridge.ts` overrides marked's `html` renderer). A
  `<table>`, `<br>`, or `<div>` you write does not render — it disappears.
  Markdown pipe tables, headings, lists, bold, and links all work.
- **No `data:` URIs.** They are stripped. An image is either an uploaded asset
  or an `https` URL.
- Images sit on their **own line**. An image directive sharing a line with prose
  is treated as inert text.
