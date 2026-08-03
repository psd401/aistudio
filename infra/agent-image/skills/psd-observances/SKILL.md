---
name: psd-observances
summary: Find cited dates for national observances, awareness months, state school holidays, education conferences, and NSPRA calendar questions such as when is an observance.
description: Answer calendar and observance questions such as "when is <observance>", national observance dates, awareness months, state school holidays, education conference dates, and NSPRA calendar lookups by searching the authorized NSPRA knowledge repository.
allowed-tools: Bash(node:*)
---

# psd-observances

Answer questions from NSPRA's *Resources for Planning the School Calendar,
2026-2027* through the caller's authorized AI Studio knowledge repository. The
publication itself is never bundled in the skill.

Use this skill when someone asks when an observance occurs, what observances
fall in a month or on a date, which school holidays a state lists, when an
education conference happens, or what the NSPRA calendar says.

## Coverage and accuracy

- Ordinary observance, state, and conference lookups cover **January 2026
  through June 2027**. Refuse an out-of-range question rather than guessing.
- `holiday-years` is the sole exception: the publication's six-year major
  holiday summary continues through **2031**.
- **Data was verified as of November 2025.**
- For state results, always disclose: **Part II is not intended to serve as the
  official or legal listing of holidays for each state.** Do not present Part II
  as legal authority.

Every returned result includes a printed-page citation. Preserve that citation
in the answer so the user can check the publication.

## Commands

```bash
# Named observance: dates and bounded comment context
node /opt/psd-skills/psd-observances/run.js \
  lookup "American Education Week"

# Ranked hybrid search. --any uses OR semantics between terms.
node /opt/psd-skills/psd-observances/run.js \
  search school counseling --any

# Observances in a covered month
node /opt/psd-skills/psd-observances/run.js month 2026-11

# Observances on a covered date
node /opt/psd-skills/psd-observances/run.js on --date 2026-11-16

# State legal and school-holiday sections, or one section only
node /opt/psd-skills/psd-observances/run.js state Washington
node /opt/psd-skills/psd-observances/run.js \
  state Washington --section school

# Education-organization meetings
node /opt/psd-skills/psd-observances/run.js \
  conferences --year 2026 --org "National PTA"

# Major-holiday dates and weekdays across 2026-2031
node /opt/psd-skills/psd-observances/run.js holiday-years Christmas
```

Global flags:

| Flag | Behavior |
|---|---|
| `--limit N` | Return 1-50 results; default 5. A state lookup without `--section` requires at least 2 so both sections are represented |
| `--full` | Expand each excerpt, while retaining a hard total-output bound |
| `--json` | Emit one machine-readable JSON object without the text truncation banner |

Default excerpts are at most about 300 characters each. Use `--full` only when
the bounded default does not contain enough context; do not try to retrieve the
whole 124-page source into model context.

## Repository and authorization behavior

The definitive source is the public AI Studio repository
`https://aistudio.psd401.ai/repositories/36`. The CLI describes repository
**36** on every invocation and passes only `repositoryIds: [36]` to search.
Never select an NSPRA source by name or search a different repository.

If repository 36 is unavailable, report that the definitive NSPRA source is
unavailable. Public repository access uses the platform's read-only service
credential when owner credentials are absent or invalid; do not tell the user
to reconnect for a failure of that shared credential.

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | Success |
| 1 | Bad arguments, out-of-range date, or unavailable NSPRA repository |
| 2 | Unexpected internal error |
| 11 | Unauthorized or insufficient scope; remediation identifies owner auth versus platform configuration |
| 12 | Upstream MCP, broker, or malformed-response error |
| 14 | Rate-limited; wait briefly and retry |
