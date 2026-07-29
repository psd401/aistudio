---
name: psd-morning-brief
summary: Opt-in personalized daily newspaper and podcast delivered privately through Atrium and the owner’s scheduled Chat response.
description: Build or configure a personalized daily morning brief with calendar, inbox, Chat, service-desk, leave, Atrium, weather, news, and custom sections. Use when someone asks for a recurring daily brief, newspaper, or podcast.
allowed-tools: Bash(node:*)
---

# psd-morning-brief

An opt-in, owner-bound three-step pipeline:

1. `--data-only` gathers only sources available to the signed owner and writes a
   snapshot.
2. The invoking agent curates that snapshot, gathers custom-section material,
   and writes synthesis JSON.
3. `--compose` creates a **private Atrium artifact**, generates the podcast, and
   returns the exact links for the scheduled Chat response.

The skill never publishes to an intranet or public Atrium destination. Creating
the artifact is the delivery operation. Its date-stamped title produces a unique
per-owner daily slug, and the owner-bound broker returns the absolute
`contentDeepLink`.

## Identity and security boundary

Pass `--user <caller-email>` verbatim from the `[caller: Name <email>]` header.
The value supports legacy composed tools that still validate a caller hint; it
is not sent as an owner selector to any broker. Every broker operation derives
the owner exclusively from the signed invocation context.

Never pass an owner id, alternate user, DM-space id, or workspace prefix.
`--owner-email`, `--user-email`, `--user-id`, `--owner-id`,
`--dm-space-name`, and `--workspace-prefix` are rejected.

All name resolution uses `psd-directory`. Do not infer a name from an email
local-part or maintain a local name mapping.

## Run the pipeline

### Step 1 — gather

```bash
node /opt/psd-skills/psd-morning-brief/run.js \
  --user <caller-email> \
  --data-only
```

The JSON result contains:

- `dataFile`: the private temporary snapshot path;
- `synthesisRequest`: the exact task, available section ids, custom-section
  instructions/sources, output shape, and curation rules;
- `omittedSections`: unavailable or unconfigured sources. Omission is expected,
  not an error.

Only section ids in `synthesisRequest.availableSections` may appear in the
synthesis. A source the owner cannot access is absent from both the newspaper
and the synthesis request.

### Step 2 — synthesize

Read `dataFile`, follow `synthesisRequest`, and write a JSON file matching
`outputShape`. Required editorial work:

- connect related facts across sections instead of dumping source output;
- curate the most useful items;
- make an explicit `act-now | review | defer | archive` decision for every
  inbox item;
- gather every custom section from its declared `sources`;
- use only directory-resolved person names from `snapshot.people`;
- write a complete, natural spoken `podcastScript`.

Write JSON only. Keep source URLs unchanged.

### Step 3 — compose and deliver

```bash
node /opt/psd-skills/psd-morning-brief/run.js \
  --user <caller-email> \
  --compose \
  --data-file <dataFile> \
  --synthesis-file <synthesis.json>
```

On success, return `deliveryMessage` verbatim in the scheduled response. It
contains the private Atrium URL and, when enabled, the podcast URL, each on its
own line so Google Chat renders them correctly.

`--compose` is intentionally strict:

- Atrium must confirm `visibilityLevel: "private"`;
- the Atrium URL must be absolute;
- missing `atrium-content` capability is a hard error;
- there is no S3, intranet, or public-publish fallback;
- podcast generation runs by default and must succeed unless the owner disabled
  it in config.

The skill self-reports a fatal run through the same owner-bound failure broker
used by `psd-failure-report` before returning its error. It calls that broker
directly so no model-supplied owner selector is forwarded.

## Legacy/debug mode

```bash
node /opt/psd-skills/psd-morning-brief/run.js \
  --user <caller-email> \
  --both
```

`--both` gathers, deterministically summarizes, composes, and delivers without
the invoking-agent synthesis step. It is useful for smoke tests and debugging,
but the scheduled production prompt should always use the three-step pipeline.

Offline-safe self-check:

```bash
node /opt/psd-skills/psd-morning-brief/run.js --test
```

## Agent-guided setup interview

Do not create a schedule until the owner has opted in. Interview them in one
short conversation:

1. Confirm delivery cadence, days, time, and IANA timezone.
2. Detect or ask which sources they have: Calendar/Gmail, Chat spaces,
   Freshservice, PSD data, and Atrium. Explain that inaccessible sections
   quietly omit themselves.
3. Propose the core sections that fit their connections.
4. Capture specific Chat spaces by resource id plus a friendly title.
5. Build “my people” one person at a time using an email or Chat id; resolve
   each with `psd-directory` before saving it.
6. Capture weather location/coordinates and news topics.
7. Ask whether they want custom sections. Each is
   `{ "title", "instructions", "sources" }`; no skill fork is needed.
8. Explain that the podcast is on by default and confirm whether they want to
   disable it.
9. Summarize the proposed config, get confirmation, write it, then create the
   schedule.

Config lives at:

```text
/home/node/.openclaw/skills/psd-morning-brief/state/config.json
```

Example:

```json
{
  "timezone": "America/Los_Angeles",
  "retainDays": 30,
  "enabledSections": [
    "calendar",
    "inbox",
    "chat",
    "freshservice",
    "staff_leave",
    "atrium",
    "weather",
    "news"
  ],
  "chat": {
    "spaces": [
      { "id": "spaces/EXAMPLE", "title": "Leadership team" }
    ]
  },
  "weather": {
    "label": "Gig Harbor",
    "latitude": 47.3293,
    "longitude": -122.5801
  },
  "news": {
    "topics": ["K-12 education", "AI in education"],
    "days": 7,
    "limit": 5,
    "sources": "web,hackernews,arxiv"
  },
  "people": [
    { "email": "colleague@psd401.net", "note": "Direct collaborator" }
  ],
  "customSections": [
    {
      "title": "Current initiatives",
      "instructions": "Summarize material changes and decisions needed today.",
      "sources": ["psd-data", "psd-plaud"]
    }
  ],
  "podcast": {
    "enabled": true,
    "voice": "Ruth",
    "engine": "long-form"
  }
}
```

With no config file, the skill uses safe defaults: every core section is
enabled but self-omits when unavailable, district-area weather and education
news topics are used, podcast is enabled, and retention is 30 days.

## Canonical schedule setup

Use a staggered minute derived for the owner; do not put everyone at `:00`.
For example, `17 6 * * 1-5` means 6:17 AM weekdays.

The schedule prompt must be:

```text
Create my morning brief using psd-morning-brief’s production three-step
pipeline. Read the exact owner email from the [caller: ...] header and pass it
verbatim as --user. First run --data-only. Read its dataFile and
synthesisRequest. Gather every custom section from its declared sources, then
write synthesis JSON with cross-section curation, a decision for every inbox
item, and a complete podcastScript. Run --compose with the returned dataFile
and your synthesis file. Reply with the command’s deliveryMessage verbatim. If
any step cannot complete, ensure the failure is self-reported before replying.
```

Create the schedule through the owner-bound scheduling skill:

```bash
node /opt/psd-skills/psd-schedules/create.js \
  --name "Morning brief" \
  --prompt "<canonical prompt above>" \
  --cron "17 6 * * 1-5" \
  --timezone "America/Los_Angeles"
```

Do not pass a user, owner, DM-space, or workspace-prefix argument to
`psd-schedules`; it derives all of them from the signed context.

## Section behavior

- Calendar and inbox use the owner’s user-account Workspace slot.
- Chat highlights use only configured spaces available to the agent account.
- Freshservice calls the fixed owner-bound broker; provider credentials never
  enter this process.
- Staff leave dynamically discovers the caller-visible absence/vacancy table
  through `psd-data`, inspects its schema, and queries today through server-side
  row-level security. Optional `staffLeave.table` and
  `staffLeave.dateColumn` disambiguate unusual warehouse schemas.
- Atrium uses the server-side `since` filter and absolute list-item URLs.
- Weather uses Open-Meteo and configured coordinates.
- News uses `psd-last30days` once per configured topic.
- Custom sections are gathered during synthesis with whatever skills/MCPs the
  owner can access.

Every included section renders a clean empty state. An unavailable section is
omitted instead of rendered as an error.

## Retention and cost

The skill records only artifact ids that it created in the owner’s state
ledger. On each successful run it permanently deletes its own ledger-tracked
briefs older than `retainDays` through the owner-bound Atrium delete operation.
It never searches and deletes by title or by another owner’s content.

Podcast audio uses Polly long-form by default and is public-by-link under the
same artifact-delivery model as `psd-tts`. Disabling it is a per-owner config
choice.
