---
name: psd-directory
summary: Who is this person? Look up an unknown email address or a Google Chat sender (users/{id}) and get the real person — name, job title, department, school. Identity lookup for staff and colleagues by email, Chat id, or message sender.
description: Resolve a district email address or a Google Chat `users/{id}` to the real person in the Peninsula SD directory — name, title, department. Use this whenever you are about to refer to someone by a raw email address or a Chat sender id, instead of guessing who they are.
allowed-tools: Bash(node:*)
---

# psd-directory — who is this person, actually

You frequently encounter an identity you cannot read: a raw address in a
message, or a Chat sender that arrives as `users/116264913639920976203`.
Guessing is the failure mode this skill exists to remove. Ask the directory.

```bash
# email -> person
node /opt/psd-skills/psd-directory/run.js --user <owner@psd401.net> --email someone@psd401.net

# Chat users/{id} -> person
node /opt/psd-skills/psd-directory/run.js --user <owner@psd401.net> --chat-id users/116264913639920976203
```

`--user` is the person whose `agnt_` account brokers the lookup — normally the
owner of the conversation you are working in.

## What comes back

One JSON line on stdout.

```json
{"found":true,"personId":"116264913639920976203","displayName":"Kris Hagel",
 "email":"hagelk@psd401.net","title":"Chief","department":"Multiple Locations",
 "organization":"Peninsula School District","cached":false}
```

A person who is not in the directory is an **answer, not an error** — exit 0:

```json
{"found":false,"query":"someone@psd401.net","reason":"not in directory"}
```

When `found` is false, say so. Do not fall back to inferring a name from the
address local-part; "hagelk@" looking like a Hagel is exactly the guess this
skill replaces.

## Rules that matter

**Never present a near match as the person.** An email lookup only reports a
person whose address matches *exactly*. The underlying Google search is a
prefix/substring search, so a partial address can return several people —
resolving to the wrong human is worse than resolving to nobody.

**Aliases resolve, and say so.** The match considers every address on a
record, not only the primary, so a `firstname.lastname` alias or a
pre-name-change address finds the right person. When the query was an alias,
the reply adds `"matchedAlias"` alongside the canonical `email` — mention the
person by name rather than implying the two addresses are different people.

**`title` and `department` come from ClassLink OneSync**, so they are as
current as the last sync, not live HR data. Treat them as descriptive, not
authoritative, for anything consequential.

**There is no way to list the directory, by design.** This skill resolves
identities you have already encountered. It cannot enumerate people, and that
is deliberate: the district directory includes student records (name, address,
grade, building), so a bulk-listing capability in the agent image would be a
student-directory dumper one prompt away. If you find yourself wanting "all
users", stop — that is not a request this tool serves, and it is not one to
work around by other means.

## Cost and caching

Lookups are cached on disk in the container: 12 hours for a hit, 5 minutes for
a miss (a miss is often a race with account provisioning, and caching that for
hours would make a new hire look permanently unresolvable).

A cache hit costs **nothing** — no directory call and no token mint. That
second part matters: minting goes through the DWD broker, which allows 120
mints per hour per person and shares that budget with `psd-workspace`, so a
lookup that minted on every call could exhaust the limit and break Gmail,
Calendar and Drive alongside it. Resolving the same person repeatedly is
genuinely free, so resolve freely rather than rationing calls — but reach for
`--no-cache` only when you have real reason to think someone was just created
or renamed, since that one does spend a mint.

## When it fails

| Exit | Meaning | What to do |
|---|---|---|
| 0 | Success, including `found:false` | Use the answer |
| 1 | Bad usage or malformed input | Fix the arguments |
| 2 | Unexpected People API error (bad request, or a malformed response) | Report it; do not retry blindly |
| 12 | Broker or People API unreachable, or the People API returned 5xx | Transient — retry once |
| 14 | The `agnt_` account is still being created | Tell the user to retry shortly |
| 16 | **Directory sharing is disabled in the Workspace admin console** | No code or retry fixes this. An admin must set Directory → Directory settings → Sharing settings → External Directory Sharing to "Organization data and authenticated user basic profile fields". Say that plainly rather than reporting a generic permission error. |
| 17 | The agent token lacks `directory.readonly` | A scope/deploy problem — report it |

Exit 16 is its own code on purpose: it was the real state of this district
until 2026-07-26, and it looks identical to a permissions bug unless you know
to name the setting.

## Scope and privilege

Uses `directory.readonly`, which the agent slot already holds — no new OAuth
scope, no consent flow, no admin role on the service account, and
`contacts.readonly` is deliberately **not** used (it grants personal contacts,
which is a different and wrong thing). See issue #1239.
