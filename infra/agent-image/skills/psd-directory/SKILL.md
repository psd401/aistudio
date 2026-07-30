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
node /opt/psd-skills/psd-directory/run.js --email someone@psd401.net

# Chat users/{id} -> person
node /opt/psd-skills/psd-directory/run.js --chat-id users/116264913639920976203
```

There is no `--user` flag. Whose directory access is used is decided by the
signed invocation context on the server, not by anything you pass — you cannot
look someone up "as" a different person.

## Literal addresses are not lookup requests

If the user supplies an address and asks you to return, repeat, quote, or
format that literal address without identifying its owner, do not call this
skill or any other tool. Follow the requested output shape directly. When the
user asks for the address exactly as written, emit it exactly once with no
label, explanation, duplication, or surrounding prose.

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

Lookups are cached server-side: 12 hours for a hit, 5 minutes for a miss (a
miss is often a race with account provisioning, and caching that for hours
would make a new hire look permanently unresolvable).

Resolving the same person repeatedly is cheap, so resolve freely rather than
rationing calls. Use `--no-cache` only when you have real reason to think
someone was just created or renamed.

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

The lookup runs **server-side**, behind `/api/agent/directory-lookup`. The
Google token is minted, used, and discarded there — it never enters this
runtime, and you never see one. That is the same containment `psd-workspace`
operates under.

It uses `directory.readonly`, which the agent account already holds: no new
OAuth scope, no consent flow, no admin role on the service account, and
`contacts.readonly` is deliberately **not** used (that grants personal
contacts, a different and wrong thing). See issue #1239.
