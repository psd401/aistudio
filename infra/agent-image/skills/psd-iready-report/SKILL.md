---
name: psd-iready-report
summary: Build a PSD-branded one-page PDF of one student's Fall i-Ready math and reading diagnostic results (scores, placement, percentile, growth goals, subtests), delivered privately to the requester's Drive.
description: Fall i-Ready student report. Use when someone asks for a student's fall i-Ready data, diagnostic, or scores as a report, printout, or PDF. Pulls diagnostics and subtests through psd-data, renders branded letter-size HTML with build.js, prints it with psd-print-pdf, and delivers it privately with psd-publish-file.
allowed-tools: Bash(node:*)
---

# psd-iready-report

One student, Fall window, one letter-size PDF in the requester's Drive.
Contributed by cantonwinej (#2023).

**This is a student record (FERPA).** Deliver it to Drive privately. Never use
`--to public`, never paste scores into a shared space, and never put the
student's data in a schedule, memory, or another person's chat.

Read the current SKILL.md of psd-data, psd-print-pdf and psd-publish-file
before running (Rule 9). Row-level security applies: if a query returns no
rows, run psd-data `permissions` before telling the user the data does not
exist.

## Steps

1. **Confirm the schema.** Run psd-data `schema` on `students`, `schools`,
   `school_years`, `iready_math_diagnostics`, `iready_reading_diagnostics`,
   `iready_math_subtest_scores` and `iready_reading_subtest_scores`. If a
   column below is gone or renamed, use the current name.

2. **Query** with psd-data `query` (each needs `--reason`). `window` is a
   column name to keep out of the SQL: select `*`, pick the `Fall` row from
   the result, and order by `yearid DESC`, never by an unquoted `window`.
   - `SELECT id, first_name, last_name, ssid, grade_level, schoolid FROM students WHERE id = <ID>`
   - `SELECT name FROM schools WHERE id = <schoolid>`
   - `SELECT id, name FROM school_years ORDER BY id DESC LIMIT 3` — the Fall
     year is the current year whose first day has passed.
   - `SELECT * FROM iready_math_diagnostics WHERE studentid = <ID> AND yearid = <Y>` — keep the row whose window is `Fall`.
   - `SELECT * FROM iready_reading_diagnostics WHERE studentid = <ID> AND yearid = <Y>` — same.
   - `SELECT * FROM iready_math_subtest_scores WHERE studentid = <ID> AND yearid = <Y>` — keep the `Fall` rows.
   - `SELECT * FROM iready_reading_subtest_scores WHERE studentid = <ID> AND yearid = <Y>` — same.

   Use the grade level from the diagnostic row for the report grade.

3. **Write the data file** with the `write` tool to
   `/home/node/.openclaw/work/iready-<ID>.json`:

   ```json
   {"fallYear":"2026","schoolYearName":"2026-27","grade":2,"generated":"Nov 2, 2026",
    "student":{"id":"…","firstName":"…","lastName":"…","ssid":"…","school":"…"},
    "math":{"diagnostic":{…row…},"subtests":[…rows…]},
    "reading":{"diagnostic":{…row…},"subtests":[…rows…]}}
   ```

   Copy the rows with the column names exactly as the warehouse returns them.
   Names are uppercase in the warehouse; convert them to Title Case. If the
   student has no Fall row for one subject, set that subject's `diagnostic`
   to `null` and `subtests` to `[]`; the report says so for that section.

4. **Render, print, deliver:**

   ```bash
   node /opt/psd-skills/psd-iready-report/build.js \
     --data /home/node/.openclaw/work/iready-<ID>.json \
     --out /home/node/.openclaw/work/iready-<ID>.html
   node /opt/psd-skills/psd-print-pdf/print.js \
     --file /home/node/.openclaw/work/iready-<ID>.html \
     --out /home/node/.openclaw/work/iready-<ID>.pdf
   node /opt/psd-skills/psd-publish-file/publish.js \
     --file /home/node/.openclaw/work/iready-<ID>.pdf
   ```

   Paste the returned `url` bare on its own line.

## Rules

- If there is no Fall row in either subject for the current year, say so
  and stop. Do not substitute an earlier year or another window without
  telling the user. `build.js` refuses a file with neither subject.
- Branding comes from psd-brand-guidelines assets (white horizontal logo,
  Pacific and Sea Glass palette, Josefin fonts). Never generate a logo.
- Subtest `level` values are truncated to 10 characters by the warehouse;
  `build.js` expands them. Pass them through as returned.
- Fall only. For Winter or Spring, tell the user this report covers the
  Fall window.
