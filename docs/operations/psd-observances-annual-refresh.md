# PSD Observances Annual NSPRA Refresh

This runbook replaces the publication behind the `psd-observances` agent skill
without copying copyrighted NSPRA content into Git. Run it separately for dev
and production, retain evidence for each environment, and do not retire the
previous edition until the replacement passes retrieval evaluation.

See the [feature guide](../features/psd-observances.md) for the skill's command,
authorization, citation, and output contracts.

## Safety contract

- The NSPRA publication is a copyrighted, members-only product. Never commit
  the PDF, generated markdown, extracted text, screenshots, or prose fixtures.
- Test and evaluation fixtures may contain observance names and dates as facts,
  but not the publication's comments or other prose.
- Do not make the repository public or student-accessible.
- Do not reuse identifiers across environments; the skill resolves the
  repository by name.
- Do not reset a shared database to recover an upload or cleanup failure.

For each target environment, record the edition, repository ID and name,
operator, upload time, item status, rollout-setting values, evaluation result,
and retirement decision in the normal operational change record.

## 1. Obtain the new edition

Purchase or obtain the new annual publication through the district's authorized
NSPRA membership. Confirm the edition and its ordinary coverage window, plus
the final year represented by its multi-year holiday summary.

Keep the source in approved operator storage only. Do not place it in this
checkout, a temporary directory under the repository, a pull-request
attachment, or an issue comment.

## 2. Protect the source from Git

Before extraction, testing, or upload, confirm that the working method keeps
both source and derivative content outside the repository. If offline tooling
is needed, use an operator-controlled directory that is not beneath any Git
worktree.

Before completing the refresh, run:

```bash
git status --short -- '*.pdf'
git diff --name-only --diff-filter=A origin/dev...HEAD -- '*.pdf'
```

Neither command may show a newly added NSPRA/source PDF. The repository contains
unrelated, intentionally tracked PDF assets, so do not use a blanket
"no PDFs anywhere" assertion. Review the refresh PR separately for copied NSPRA
prose; a clean PDF check alone does not detect extracted text.

## 3. Confirm content-platform settings

In the target environment's settings administration path, confirm all three
settings are `true`:

- `CONTENT_PLATFORM_ENABLED`
- `CONTENT_READ_V2_ENABLED`
- `CONTENT_REPOSITORY_CUTOVER_ENABLED`

These settings default to `false` and are independent per environment. The
canonical upload path is active only when all three are enabled. Record their
values before uploading.

If they are not all enabled, stop and complete the normal reviewed rollout
procedure. Do not upload and hope processing catches up later. A known symptom
of a disabled canonical path is an item remaining `pending` with no
`registerCanonicalUpload` activity.

## 4. Create or verify the repository

Use Repository Manager to create a new repository or inspect the repository
that will receive the edition. It must satisfy every condition below:

- it is a normal user-managed repository, never `systemManaged`;
- its name contains **"NSPRA"**, case-insensitively;
- staff-role access is granted;
- public access is disabled; and
- intended staff can see it with their own AI Studio identity.

Retrieval deliberately excludes `systemManaged` repositories. The name
substring is also part of the runtime contract: repository IDs differ between
dev and production and must never be copied into the skill.

If more than one accessible repository contains "NSPRA", remember that the
skill prefers a name containing "2026", then the lowest numeric ID. Rename or
retire ambiguous repositories deliberately rather than relying on an
accidental selection.

For the cleanest rollback boundary, create a replacement repository and leave
the prior repository intact until the new items are active. Immediately before
testing the replacement, rename the prior repository so its name no longer
contains "NSPRA"; record both names so the change can be reversed. This matters
for later editions because an older name containing "2026" otherwise wins the
skill's current selection rule. If the existing repository is reused instead,
remove its prior-edition items from retrieval before evaluation so old and new
dates cannot be mixed.

## 5. Upload and verify processing

Upload the new publication through Repository Manager. Do not add repository
write access to the agent and do not add a new broker route or MCP tool for this
operation.

Wait until every new item is `active` before testing or promotion. Record the
item count and final status, and inspect failures through the normal canonical
content processing telemetry. Stop on any pending, failed, or partially
processed item; do not treat partial retrieval as a successful refresh.

Apply the repository-name cutover from step 4, then run a skill lookup. Each
invocation calls `repositories_list` and reports the selected repository;
record that selection before scoring any lookup. If the replacement is not
selected, stop and correct the names rather than accepting results from the
prior edition.

Run representative staff-authenticated lookups and confirm:

- the expected repository was selected;
- results include printed-page citations;
- default output remains bounded; and
- an authenticated, correctly scoped account without this repository's ACL
  receives the "NSPRA repository is not available" response instead of source
  data; and
- a caller with missing, expired, or insufficient repository scope receives
  the connect/reconnect hint.

## 6. Update runtime and documented coverage

Update the executable coverage contract in
[`run.js`](../../infra/agent-image/skills/psd-observances/run.js) before
changing the documentation:

- set `COVERAGE_START`, `COVERAGE_END`, `ACCURACY_NOTICE`, and
  `COVERAGE_NOTICE` for the new edition;
- update ordinary free-form year/month/period validation, including any
  hardcoded boundary year or partial-year rules;
- update the accepted conference years and their error message; and
- update the multi-year holiday bounds and the years placed into its search
  query.

Search the runtime for every old boundary year and verification date so an
obsolete validator, notice, or query term cannot survive the refresh. Then
update
[`run.test.js`](../../infra/agent-image/skills/psd-observances/run.test.js) to
prove the new first/last ordinary dates, refused out-of-range dates, accepted
conference years, holiday-summary bounds/query, and coverage notices. Run:

```bash
bun run test:skill:psd-observances
```

Only after that contract passes, update the coverage and accuracy section in
[`SKILL.md`](../../infra/agent-image/skills/psd-observances/SKILL.md) and the
[feature guide](../features/psd-observances.md) to match the new edition.
Update both the ordinary date window and the multi-year-summary end year.

Review every example date and evaluation fixture for the new range. Facts such
as names and dates are permitted; remove or replace any fixture that contains
source prose. Keep the `summary` frontmatter and calendar-oriented trigger
phrasing intact so skill discovery continues to work.

## 7. Re-run the retrieval evaluation

Run the committed `psd-observances` retrieval evaluation against the real
repository in the target environment, not mocks. The evaluation gate is
documented in the
[live retrieval evaluation guide](../../infra/agent-image/skills/psd-observances/evals/retrieval-eval.md).
Provide a short-lived key through `PSD_OBSERVANCES_EVAL_API_KEY`; never pass a
key on the command line:

```bash
export PSD_OBSERVANCES_EVAL_API_KEY="<short-lived repository-read key>"

bun run eval:skill:psd-observances-retrieval -- \
  --environment dev \
  --base-url https://dev.aistudio.psd401.ai \
  --out /tmp/psd-observances-dev-retrieval-report.json

unset PSD_OBSERVANCES_EVAL_API_KEY
```

Change both the environment label and base URL for production. The key needs
only `repositories:list`, `repositories:read`, and `repositories:search`.
Reports are transcript-free, but keep them in an environment-specific
temporary path until their names/dates, citations, and aggregate figures have
been reviewed.

Verify expected answers against the authorized printed source, then record:

- named-lookup accuracy;
- enumeration recall;
- citation correctness; and
- any `needsOcrPages` entries or spurious OCR results.

The current decision gate requires at least 90% Class A named-lookup accuracy
and at least 80% Class B enumeration recall. A Class A result below 90% requires
investigation before promotion. Class B recall below 80% requires the
structured-markdown decision described in
[#1478](https://github.com/psd401/aistudio/issues/1478); generated content must
still remain outside Git.

Repeat the evaluation in dev and production. Do not infer production success
from a dev result because flags, repository IDs, ACLs, and ingested items are
environment-specific.

## 8. Retire the prior edition

Keep the old edition available until the replacement is active, the skill and
feature guide describe the new range, and the target environment passes the
retrieval gate. A prior repository renamed in step 4 remains the rollback copy
until this point. Then remove the prior items or repository through Repository
Manager and confirm the replacement still resolves by the "NSPRA" name rule.

Cleanup caveat: [#1474](https://github.com/psd401/aistudio/issues/1474)
documented a failure when deleting `pending` items because migration 010 did
not allow the `cancelled` processing status. The fix landed in migration
`168-repository-item-cancelled-status.sql` through
[PR #1481](https://github.com/psd401/aistudio/pull/1481). Before cleanup, verify
that migration 168 is deployed in the target environment. Older deployments
can still hit the original constraint failure.

Even with the fix deployed, verify new and old uploads reach a terminal state
before depending on cleanup. If retirement fails, preserve the old repository,
capture identifiers and status without source text, and repair the target
environment through the normal migration/deployment path.

## Completion evidence

The annual refresh is complete only when:

- no source or derivative NSPRA content was committed;
- all three content-platform settings were confirmed in both environments;
- each selected repository is user-managed, staff-restricted, non-public, and
  named with the required substring;
- every replacement item is active;
- runtime validation/query bounds, unit tests, `SKILL.md`, and feature
  documentation all match the new date range;
- real-repository evaluation passed in dev and production with citations
  recorded; and
- retirement completed safely, or the retained prior edition and cleanup
  blocker were explicitly recorded.
