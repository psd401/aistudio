---
name: psd-redrover
summary: Read-only access to PSD Red Rover absence and vacancy data — daily and weekly staff-attendance reporting.
description: Query Red Rover absence-management data for Peninsula School District. Supports raw vacancy listings for a date range, daily summaries (all staff or certificated-only), and weekly trend reports. Strictly read-only — never creates, modifies, or deletes data in Red Rover. Authenticates with a single district-wide credential set fetched from AWS Secrets Manager via psd-credentials (shared scope).
allowed-tools: Bash(node:*)
---

# psd-redrover

Read-only access to Red Rover absence/vacancy data for PSD. The skill never performs POST/PUT/DELETE/PATCH calls — every HTTP request goes through a single `rrGet()` chokepoint in `lib/api.js`. There is no companion write helper; adding one would violate the read-only contract.

**Identity.** Every command requires `--user <caller-email>`. Pass the email verbatim from the `[caller: Name <email>]` header in the user turn. The email is used only as the `--user` argument to `psd-credentials/get.js`; the credential itself is district-wide (shared scope), not per-user.

**Credentials.** A single shared secret at `psd-agent-creds/{env}/shared/redrover_credentials` with shape `{"username":"...","password":"...","apiKey":"..."}`. The skill uses Basic Auth (`username` + `password`) for the `/organization` endpoint, then uses the dynamic `apiKey` returned there for vacancy calls. The static `apiKey` field is a fallback if Red Rover ever stops minting a dynamic one.

If the credential is missing the skill exits non-zero with `error: "redrover_credentials_missing"` — an administrator must provision it out of band; users cannot register Red Rover credentials themselves.

## Configuration

- **Base URL:** `https://connect.redroverk12.com`
- **Org:** Peninsula School District
- **Auth:** HTTP Basic Auth + `apiKey` header (dynamic, from `/organization`)
- **Rate limit:** 100 requests/minute (Red Rover server-side)

## Commands

### `get_organization` — validate credentials, return orgId + dynamic apiKey

```bash
node /opt/psd-skills/psd-redrover/get_organization.js --user <email>
```

Returns `{"orgId":..., "name":"...", "apiKey":"..."}`. Useful as a connectivity smoke test. Never include the `apiKey` in chat output — it's returned for tooling only.

### `get_absences` — raw vacancy data for a date range

```bash
node /opt/psd-skills/psd-redrover/get_absences.js \
  --user <email> \
  --start <YYYY-MM-DD> \
  --end <YYYY-MM-DD> \
  [--filter filled|unfilled|all]
```

Maximum range: 31 days. Returns `{ start, end, filter, total, data: [...] }` where `data` is the raw vacancy records.

### `get_daily_summary` — all-staff daily summary

```bash
node /opt/psd-skills/psd-redrover/get_daily_summary.js --user <email> [--date <date>]
```

`<date>` accepts: `today` (default), `yesterday`, day names (`monday`, `tuesday`, ...), `last <day>` (`last friday`, etc.), or an explicit `YYYY-MM-DD`.

Output: counts by school, reason, and position type; filled/unfilled split; fill rate; full unfilled-positions list; full absence detail list.

### `get_certificated_summary` — certificated-staff-only daily summary

```bash
node /opt/psd-skills/psd-redrover/get_certificated_summary.js --user <email> [--date <date>]
```

Same date options. Filters to position types `Teacher`, `ESA - Certificated`, `CTE - Teacher`. This is the most-requested report — focuses on classroom coverage.

### `get_weekly_summary` — weekly trends (Mon–Fri)

```bash
node /opt/psd-skills/psd-redrover/get_weekly_summary.js --user <email> [--weeks-ago <n>]
```

`--weeks-ago 0` (default) = this week, `1` = last week, etc. (max 52). Returns daily breakdown, peak/slow days, fill rate, and trend annotations.

## Common workflows

| Question | Command |
|----------|---------|
| "How many teachers were out yesterday?" | `get_certificated_summary.js --user <email> --date yesterday` |
| "Show unfilled positions for today" | `get_daily_summary.js --user <email>` (look at `unfilled_positions`) |
| "Weekly absence trends" | `get_weekly_summary.js --user <email>` |
| "Last week's summary" | `get_weekly_summary.js --user <email> --weeks-ago 1` |
| "Unfilled subs Mon–Fri this week" | `get_absences.js --user <email> --start <Mon> --end <Fri> --filter unfilled` |

## Output schemas

### Daily summary (all staff)

```json
{
  "date": "yesterday",
  "date_iso": "2026-01-26",
  "day_of_week": "Monday",
  "full_date": "Monday, January 26, 2026",
  "total_absences": 110,
  "filled": 75,
  "unfilled": 35,
  "fill_rate": 68,
  "by_school": { "PENINSULA HIGH SCHOOL": 13, "...": "..." },
  "by_reason": { "SICK LV > 1 SICK": 54, "...": "..." },
  "by_position_type": { "Teacher": 55, "Paraprofessional": 36 },
  "unfilled_positions": [{ "school": "...", "position": "...", "employee": "...", "start": "...", "end": "..." }],
  "absences": [{ "...": "..." }]
}
```

### Weekly summary

```json
{
  "week": "Jan 20-24, 2026",
  "week_label": "this week",
  "date_range": { "start": "2026-01-20", "end": "2026-01-24" },
  "total_absences": 450,
  "daily_average": 90,
  "filled": 380,
  "unfilled": 70,
  "fill_rate": 84,
  "peak_day": { "day": "Monday", "count": 120 },
  "slow_day": { "day": "Friday", "count": 65 },
  "by_day": { "Monday": 120, "Tuesday": 95, "Wednesday": 90, "Thursday": 80, "Friday": 65 },
  "trends": [{ "type": "info", "message": "Monday had 120 absences (50%+ above average)" }]
}
```

## Data fields (vacancy records)

| Field | Meaning |
|-------|---------|
| `absenceDetail.employee` | Employee who is absent |
| `absenceDetail.reasons[0].name` | Reason category (SICK, PERSONAL, etc.) |
| `location.name` | School name |
| `position.title` | Position title |
| `position.positionType.name` | Position category (Teacher, Paraprofessional, etc.) |
| `substitute` | If present, position is filled |
| `start` / `end` | Absence time range |
| `needsReplacement` | Whether a sub is required |

## Schools in PSD (common location names)

PENINSULA HIGH SCHOOL, GIG HARBOR HIGH SCHOOL, HENDERSON BAY HIGH SCHOOL, GOODMAN MIDDLE SCHOOL, HARBOR RIDGE MIDDLE SCHOOL, KEY PENINSULA MIDDLE SCHOOL, KOPACHUCK MIDDLE SCHOOL, ARTONDALE ELEMENTARY SCHOOL, DISCOVERY ELEMENTARY SCHOOL, EVERGREEN ELEMENTARY SCHOOL, HARBOR HEIGHTS ELEMENTARY SCHOOL, MINTER CREEK ELEMENTARY SCHOOL, PIONEER ELEMENTARY SCHOOL, PURDY ELEMENTARY SCHOOL, SWIFT WATER ELEMENTARY SCHOOL, VAUGHN ELEMENTARY SCHOOL, VOYAGER ELEMENTARY SCHOOL.

## Read-only enforcement

- All HTTP traffic flows through `rrGet()` in `lib/api.js`. There is no `rrPost`/`rrPut`/`rrDelete`.
- The skill performs **no** filesystem writes (no `fs.writeFile`, `fs.appendFile`, `fs.mkdir`, `fs.unlink`, etc.).
- The only `child_process` invocation is `node psd-credentials/get.js` — never `put.js`.
- `/opt/psd-skills` is `chmod a-w` at container build time; the agent process cannot modify the skill at runtime.
- Credential values are kept in module-scope memory only — never logged, echoed, or persisted to workspace/S3.
