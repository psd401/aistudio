# PSD Observances Agent Skill

`psd-observances` answers date-oriented questions from NSPRA's
*Resources for Planning the School Calendar, 2026-2027* without putting the
124-page publication into model context. The skill queries a staff-authorized
AI Studio knowledge repository through the existing repository MCP tools and
returns small, cited result sets.

The publication is a copyrighted, members-only source. Neither the PDF nor its
extracted prose belongs in this public repository. AI Studio stores the source
outside Git in the normal knowledge-repository data path.

## Coverage and accuracy

- Ordinary observance, state-holiday, and conference lookups cover **January
  2026 through June 2027**.
- The six-year major-holiday summary is the only surface that continues
  through **2031**.
- The source data was verified as of **November 2025**.
- Part II is not an official or legal listing of each state's holidays. Treat
  state results as planning information and verify legal questions against an
  authoritative state source.
- Questions outside the applicable range must be refused rather than guessed.

Every result includes the printed page from `sourceLocator.page`. Preserve that
citation when answering so staff can verify the result against their authorized
copy.

## Command surface

The runnable skill lives at
[`infra/agent-image/skills/psd-observances/`](../../infra/agent-image/skills/psd-observances/).

| Command | Purpose |
|---|---|
| `lookup <name>` | Find a named observance and its date information |
| `search <terms> [--any]` | Search the whole publication with ranked hybrid retrieval; `--any` uses OR semantics |
| `month <YYYY-MM>` | Find observances in a covered month |
| `on --date <YYYY-MM-DD>` | Find entries associated with a covered date |
| `state <name> [--section legal\|school]` | Find a state's legal-holiday and/or school-holiday sections |
| `conferences [--year N] [--org <text>]` | Find education-organization meetings |
| `holiday-years <name>` | Find a major holiday in the 2026–2031 summary |

Examples and agent-facing invocation guidance are maintained in the
skill's [`SKILL.md`](../../infra/agent-image/skills/psd-observances/SKILL.md).

## Output bounds

The skill intentionally limits what enters agent context:

- Default output contains no more than five results.
- Default excerpts are limited to about 300 characters per result.
- `--limit N` accepts 1–50 results. An unfiltered `state` request needs at
  least two result slots so both legal and school sections can be represented.
- `--full` expands excerpts but still enforces a total-output bound.
- `--json` emits one machine-readable object and omits the text truncation
  banner.

Use the default form first. Expand a result only when the bounded excerpt does
not answer the question; do not use the skill to reconstruct the publication.

## Repository resolution

Each invocation calls `repositories_list` and selects an accessible repository
whose name contains **"NSPRA"**, case-insensitively. The skill never stores an
environment-specific repository ID.

If several repositories match, it prefers a name that also contains
**"2026"**, then the lowest numeric repository ID, and reports which repository
it selected. If none match, it explains that the NSPRA repository is not
available to the caller's account.

The repository must be a normal user-managed repository. Retrieval excludes
repositories whose metadata marks them `systemManaged`. It must also remain
staff-restricted and not public because the source is copyrighted.

## Authorization behavior

The agent broker resolves credentials in this order:

1. the caller's AI Studio OAuth token;
2. the caller's personal `sk-` key, when configured;
3. the shared platform key.

The shared key has only `platform:read`; it cannot search knowledge
repositories. Normal use therefore relies on the caller's OAuth grant, or on a
personal key with the required repository access. Repository ACLs still apply
to every request.

An unauthorized or insufficient-scope response exits with code `11` and tells
the caller to connect AI Studio access. If AI Studio is already connected,
reconnect it so the current repository scopes are authorized. Upstream MCP
failures use code `12`, and rate limits use code `14`.

## Operations

Repository contents and edition changes are operational data, not source-code
changes. Follow the
[annual NSPRA refresh runbook](../operations/psd-observances-annual-refresh.md)
when replacing the publication, changing its coverage window, validating
retrieval, or retiring the prior edition.
