# Google Directory Group Sync

Group membership from Google Workspace becomes a first-class authorization source
in AI Studio: an hourly service-account sync mirrors selected Google groups (and
their transitive membership) into the database, and that membership drives two
things — a user's **roles** (via group→role mappings) and **per-resource access
grants** on models, assistants, and agent skills. Authentication does **not**
change: Cognito + Google OIDC stay exactly as deployed; groups arrive out-of-band.

This is Epic #1202 (sub-issues #1203–#1207). This document is the architecture +
operations reference; the authorization model it plugs into is described in
[capabilities-and-scopes.md](../architecture/capabilities-and-scopes.md).

---

## Architecture

```
Google Workspace Directory
        │  (hourly EventBridge rule + admin "Sync now")
        ▼
  group-sync Lambda  ── infra/lambdas/group-sync
        │  service account (Cloud Identity API, or Admin SDK via DWD)
        │  1. resolve selection (picks ∪ prefix rules)
        │  2. fetch transitive membership per group
        │  3. full-replace group_members per group (last-known-good fail-safety)
        │  4. reconcile managed roles from the fresh membership
        ▼
   Postgres (Aurora)
     groups · group_members · group_selection_rules       (membership, mig 106)
     group_role_mappings                                   (group→role, mig 109)
     user_roles.source = 'group-sync' | 'manual'           (managed-role flag, mig 109)
     resource_access_grants (grant_kind 'role' | 'group')  (per-resource, mig 111)
        ▲
        │  reads
   App (Next.js)
     · role reconciliation at login (getCurrentUserAction) and JIT (resolveUserId)
     · per-resource gate (lib/db/drizzle/resource-access.ts) on model/assistant/skill
     · Atrium 'group' visibility grants (#1205)
```

### Data model

| Table | Purpose | Key columns |
|---|---|---|
| `groups` | one row per synced Google group | `group_email` (unique on `lower()`), `is_active`, `last_synced_at`, `last_sync_error` |
| `group_members` | transitive membership, keyed by **email** (not a users FK) | `group_id`, `member_email` (stored lowercased) |
| `group_selection_rules` | admin selection config | `rule_type` (`pick`\|`prefix`), `value`, `is_active` |
| `group_role_mappings` | group email → role | `group_email`, `role_id` |
| `user_roles.source` | managed-role flag | `'group-sync'` (reconciler-owned) vs `'manual'` (admin/heuristic) |
| `resource_access_grants` | per-resource role/group grants | `resource_type`, `resource_id`, `grant_kind`, `grant_value` |

### Email is the authorization join key

Membership is keyed by **email**, not a `users` foreign key, so a person who has
never signed in still syncs; joins to `users` resolve lazily as
`lower(users.email) = lower(group_members.member_email)`. Every email comparison in
the reconcilers and the resource gate lowercases **both** sides. Because email is an
authz join key it must be single-valued: migration 112 (#1207) adds a unique index
on `lower(users.email)` — see [Duplicate-email remediation](#duplicate-email-remediation).

### Fail-safety invariants (do not regress)

- A per-group member-fetch failure keeps that group's **last-known-good** membership
  (`replaceMembers` is never called for it; only `markError`). One group's failure
  never aborts the others.
- A whole-directory listing failure (or an empty listing) **skips deactivation** —
  a partial sync must never mass-revoke. `pick` rules are always selected regardless.
- Membership full-replace is transactional; a reader never sees a half-rebuilt group.
- The **last-administrator guard** refuses to auto-revoke the final administrator
  grant(s); it takes a shared advisory lock so the hourly bulk reconcile and the
  login-time per-user reconcile serialize against each other.
- Directory pagination is **exhaustive** (the client follows every `nextPageToken`),
  so there are **no silent caps** — selection size is emitted as the `GroupsSelected`
  metric and logged per run.

---

## Settings

All configuration is database-first, in the `settings` table (Admin → Settings),
read identically by the app (`lib/groups/settings.ts`) and the Lambda
(`infra/lambdas/group-sync/config.ts`). Keys:

| Setting key | Meaning |
|---|---|
| `GROUP_SYNC_ENABLED` | Master switch. Only the exact string `true` enables the **hourly** run. Manual "Sync now" runs whenever a SA secret is configured, even while paused. |
| `GOOGLE_DIRECTORY_SA_SECRET_ARN` | Secrets Manager ARN of the Google service-account JSON key. Must match the `aistudio-<env>-google-directory-*` name family the Lambda's IAM role is scoped to. |
| `GOOGLE_DIRECTORY_CUSTOMER_ID` | Cloud Identity customer id (e.g. `C0xxxxxxx`). Required for the Cloud Identity path. |
| `GOOGLE_DIRECTORY_DWD_SUBJECT` | Optional admin email to impersonate. **Set** → Admin SDK Directory API via domain-wide delegation. **Unset** → Cloud Identity API with a Groups-Reader service account (no impersonation, preferred). |

**Selection** (Admin → Groups) is stored in `group_selection_rules`: `pick` rows name
an exact group email; `prefix` rows select every directory group whose email starts
with the prefix. A pick always wins over a prefix. **Group→role mappings** (same admin
page) populate `group_role_mappings`. The group directory and mappings are visible to
all authors by design; there is no write-time group-existence validation (a mapping
to a not-yet-synced group simply grants nothing until the group syncs).

---

## Observability (#1207)

The Lambda emits CloudWatch metrics in namespace **`AIStudio/GroupSync`** (dimension
`Environment`): `GroupsSelected`, `GroupsSynced`, `GroupsFailed`,
`GroupsDeactivated`, `MembersTotal`, `RolesGranted`, `RolesRevoked`,
`RoleUsersChanged`, `SyncRunFailed`, and `SyncRunSucceeded`.

Two alarms are defined in `infra/lib/processing-stack.ts`. Both publish to the
shared `aistudio-<environment>-monitoring-alarms` topic owned by MonitoringStack;
that stack owns email and other delivery subscriptions:

| Alarm | Fires when | Why |
|---|---|---|
| `psd-group-sync-failure-<env>` | the Lambda's `Errors` metric ≥ 1 in an hour | a run executed but errored (directory outage, DB failure, crash/timeout). The handler re-throws on failure, so `Errors` captures both crashes and handled-then-rethrown failures. |
| `psd-group-sync-staleness-<env>` | `SyncRunSucceeded` sum < 1 across 3 consecutive hours, **treat-missing-as-breaching** | no successful sync recently — including the case where the schedule stopped firing entirely (a dead Lambda emits nothing, so a self-emitted "seconds since last sync" gauge could not detect it). |

> **New-environment note:** when group sync is intentionally not configured
> (`GOOGLE_DIRECTORY_SA_SECRET_ARN` unset), the Lambda returns `skipped` before
> emitting `SyncRunSucceeded`, so the metric is permanently absent and
> `psd-group-sync-staleness-<env>` sits in **ALARM** by design (`treatMissingData:
> BREACHING`). This is expected onboarding noise, not an incident — notifications are
> delivered through the shared monitoring topic. It clears on the first successful
> sync once the service account is configured. Before enabling group sync in a new
> environment, deploy MonitoringStack and confirm at least one delivery endpoint. If
> an environment will never use group sync, disable the alarm rather than leaving it
> red.

Per-group failures are surfaced in **Admin → Groups**: each group shows a "Failed"
badge (with the `last_sync_error` as tooltip) and `last_synced_at`; the header shows
an aggregate "Failed syncs" count (`groups.last_sync_error IS NOT NULL AND is_active`).

### Test-firing the alarms after deploy

1. **Failure alarm**: temporarily point `GOOGLE_DIRECTORY_SA_SECRET_ARN` at a bad
   secret (or invoke with the SA secret revoked) so a run throws; confirm
   `psd-group-sync-failure-<env>` → ALARM and the shared monitoring notification
   fires; restore the setting.
2. **Staleness alarm**: set `GROUP_SYNC_ENABLED=false` and let 3 hourly windows pass
   with no manual run; confirm `psd-group-sync-staleness-<env>` → ALARM (missing data
   breaches); re-enable and run "Sync now" to clear it.

---

## Runbooks

### Sync failure (alarm: `psd-group-sync-failure`)

1. Read the Lambda logs: `/aws/lambda/psd-group-sync-<env>` (structured JSON).
2. Common causes: expired/rotated SA key (fix the secret, then "Sync now"),
   Directory API permission loss (re-grant Groups Reader / re-check DWD scopes),
   Aurora unreachable (VPC/security-group/credentials).
3. **Membership is safe** while you fix it: each failing group keeps its
   last-known-good membership (`last_sync_error` is set, `last_synced_at` is not
   touched). No mass-revoke occurs.
4. After the fix, click **Sync now** and confirm `GroupsFailed` drops to 0 and the
   per-group "Failed" badges clear.

### Staleness (alarm: `psd-group-sync-staleness`)

1. Check `GROUP_SYNC_ENABLED` is `true` and the hourly EventBridge rule
   `GroupSyncHourlySchedule` is enabled.
2. Check the Lambda isn't throttled (it has `reservedConcurrentExecutions: 1`; a
   stuck manual run can block the scheduled one — confirm no long-running invocation).
3. Run **Sync now**; confirm `SyncRunSucceeded` returns and the alarm clears.

### Group rename in Google

Group renames **are handled**: the group is keyed by `group_email`, and a renamed
group re-enters the selection under its new email and syncs normally. Two operational
notes:

- **Selection lists reference emails.** A `pick` rule or a `group_role_mappings` row
  names the group by its *old* email. After a rename, update the pick/mapping to the
  new email (Admin → Groups) or the old email selects/maps nothing. Prefix rules that
  still match the new email need no change.
- The old-email `groups` row falls out of the selection and is flipped
  `is_active=false` (never hard-deleted), so its membership survives if you re-add it.

### Member email change (Workspace rename of a person)

`group_members` tracks the directory's **current** address, but `users.email` is set
at provisioning. On the member's next sign-in the app refreshes `users.email` from the
session (`getCurrentUserAction`) so the join realigns. Between the rename and that next
sign-in, the hourly bulk reconciler may drop the person's managed roles once
(documented residual) — the login-time reconciler restores them. If a person seems to
have lost group-driven roles after a rename, have them sign in again.

### Duplicate-email remediation

Migration 112 adds a unique index on `lower(users.email)`. It **fails the deploy** if
the target database already has two rows with the same case-insensitive email — by
design, so we never ship a partial index that hides the ambiguity. Before deploying:

```bash
DATABASE_URL=<target> bun run scripts/db/report-duplicate-emails.ts
```

- Exit 0 → no duplicates; migration 112 applies cleanly.
- Exit 1 → duplicates printed (email + colliding user ids). **Remediate first**:
  decide the surviving `users` row per email, re-point its foreign keys
  (`user_roles`, conversations, documents, api_keys, …) from the duplicates onto the
  survivor, delete the duplicates, then re-run the report until it exits 0.
  Dedupe is a deliberate human step — never automated in a migration, and never
  worked around by weakening the index to a partial one.

---

## Retiring the username heuristic (#1207)

New-user provisioning assigns a default role from a username heuristic
(`lib/auth/default-role.ts`: all-digit username → `student`, else `staff`). Group-sync
is now the authoritative role source — both provisioning paths reconcile managed roles
immediately after — so this heuristic only decides the role for a user in **no** mapped
group. Reducing it to a no-role default (`defaultRoleForNewUser` returns `null`) is
**coverage-gated**:

```bash
DATABASE_URL=<prod> bun run scripts/db/report-heuristic-only-roles.ts
```

Decision rule from the report's "manual roles NOT reproduced by group-sync":

- **staff count ≈ 0** → safe to drop the non-numeric→`staff` branch (return `null` for
  staff; rely on group-sync). New staff get `staff` at login-time reconciliation from
  their mapped group.
- **staff count large** → map the missing staff groups to the `staff` role first, then
  re-run the report before dropping the branch.
- The numeric→`student` branch is least-privilege and low-risk regardless.

The change is a single edit in `lib/auth/default-role.ts` (return `null` for the
retired branch); both call sites already guard on a `null` return.

---

## Key source locations

- Lambda: `infra/lambdas/group-sync/` (`index.ts` handler, `sync.ts` reconciler core,
  `directory-client.ts`, `db.ts`, `config.ts`)
- CDK: `infra/lib/processing-stack.ts` (Lambda, hourly rule, alarms)
- Reconcilers: `lib/db/drizzle/user-roles.ts` (`reconcileUserManagedRoles`),
  `infra/lambdas/group-sync/db.ts` (`reconcileManagedRoles` bulk pass)
- Per-resource gate: `lib/db/drizzle/resource-access.ts`
- Admin UI: `app/(protected)/admin/groups/`
- Reports: `scripts/db/report-duplicate-emails.ts`,
  `scripts/db/report-heuristic-only-roles.ts`
- Migrations: `106-groups`, `109-group-role-mappings`, `110-atrium-group-grant-kind`,
  `111-resource-access-grants`, `112-users-email-unique`,
  `113-drop-ai-models-allowed-roles`
