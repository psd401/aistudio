# Atrium artifact data

Atrium artifact data is the first-party persistence path for sandboxed HTML/JS
artifacts. It lets an authenticated artifact append and list small JSON records
without giving untrusted code network access, cookies, storage, a content id, or
a reusable credential.

It also carries a second, read-only operation: viewer-scoped PSD data queries
(#1705), where an artifact asks the district data server for rows **as the
person viewing the page**, under that viewer's own row-level permissions.

This document describes the implementation shipped by issues #1516–1520, the
agent guidance in #1521, and the viewer-scoped query bridge in #1705. The
broader content, sandbox, visibility, and publishing design remains in the
[Atrium design specification](./atrium-design-spec.md).

## Architecture

```text
artifact code (sandbox="allow-scripts", opaque origin, connect-src 'none')
  window.AtriumData.submit/list
        │ postMessage request
        ▼
dedicated sandbox host (infra/sandbox-host/render.html)
        │ postMessage request
        ▼
ArtifactSandbox parent on the authenticated AI Studio origin
  - authenticates event.source === iframe.contentWindow
  - supplies contentId from trusted React props
        │ session-authenticated Server Action
        ▼
submitArtifactRecord / listArtifactRecords
  - resolves the session user and content visibility
  - validates namespace, payload, scope, and bounds
        │
        ▼
content_data_records (Aurora PostgreSQL)
```

The bridge is deliberately enabled only by a trusted authenticated caller that
has already resolved the object server-side and holds its content id. Artifact
code must catch a rejected bridge call and present a state such as "Sign in to
see scores."

### Where the bridge is live (#1725)

| Surface | Bridge | Why |
|---|---|---|
| `/c/<slug>` intranet reader | **enabled** | Authenticated, `canView`-gated, published. |
| `/atrium/<id>/view` full-screen viewer | **enabled** | Same `canView` gate; renders the CURRENT head, so it is the one surface a DRAFT can run on. |
| `/atrium/<id>/edit` canvas preview | **enabled** | Same gate; this is where the artifact is authored. |
| Nexus workspace panel (`?workspace=`) | **enabled** | The same canvas behind the same `canView`-gated loader. |
| `ArtifactEmbedBlock` (artifact inside a document) | fail closed | Renders inside somebody else's document, including the anonymous public reader. |
| Library thumbnails | fail closed | Decorative grid tiles; nothing to interact with. |
| `/p/<slug>` public reader | fail closed | Anonymous — there is no viewer to scope a query to. |

Publication was **never** the authorization. `queryArtifactData`,
`submitArtifactRecord`, and `listArtifactRecords` each independently resolve the
session, run `contentService.get` (the shared 404 mask + `canView`), re-check
`kind === "artifact"`, and re-check the artifact's CURRENT `data_access` mode;
none of them reads publication state. Enabling the bridge on the two authoring
surfaces therefore changes only *where* a request may originate, not *who* may
run one — and it removes the publish → check → republish loop that used to be the
only way to find out whether a `query`-mode dashboard worked. The no-egress
invariant is unchanged: same sandbox, same CSP, same server checks, same
records/query exclusivity.

Every enabling caller also pins `dataAccess` (#1712). On the authoring surfaces
the mode is editable in place, so the canvas keys its sandbox on the artifact id
**and** the mode: flipping the mode in Content settings remounts the frame, which
is exactly the "fresh load" the pin requires (the old iframe is destroyed, so
nothing queried under the old mode survives) while still letting an author test
the mode they just chose without reloading by hand.

Teacher-facing agent workflows use the separate signed-owner broker read:

```text
psd-atrium list-data
  -> POST /api/agent/atrium (signed invocation envelope)
  -> inner GET /<content-id>/data?namespace=<namespace>&limit=<limit>
  -> content_data_records
```

That broker path is not an `/api/v1/` endpoint. It applies the signed workspace
owner's content visibility, checks that the object is an artifact, and returns
display names without exposing user ids or email addresses.

## Data access modes

Every content object carries `data_access` (migration 179), which decides which
bridge operation its artifact may use:

| Mode | Allowed | Notes |
|---|---|---|
| `records` | `submit`, `list` | The DEFAULT, including for every object created before migration 179. |
| `query` | `query` | Viewer-scoped, read-only PSD data. `submit`/`list` are refused. |
| `none` | nothing | The bridge answers every operation with the generic failure. |

**The modes are mutually exclusive, and that is a security control.** It is the
single enforcement point of the invariant the query feature rests on: a
data-connected artifact has *no egress*. Network is closed by the sandbox CSP
(`connect-src 'none'`, `img-src` with no https wildcard, `form-action 'none'`,
`base-uri 'none'`, `webrtc 'block'`, and `sandbox="allow-scripts"` with no
navigation or popups). The data MCP's write tools and CSV export links are closed
by the server-side tool allowlist. The one remaining channel would be writing
rows into `content_data_records` and reading them back as the author — which the
exclusivity closes. With every path shut, a data-connected artifact is a pure
function from "what this viewer may see" to pixels on this viewer's screen,
whatever its author intended, so no per-artifact review or admin approval is
required.

Evaluate every FUTURE bridge operation against that invariant before shipping it.

The mode is owner-settable in the editor's **Content settings** dialog (artifacts
only) and via the `create_artifact` / `update_content` MCP tools.

### The mode is enforced twice, and a change only lands on a fresh load (#1712)

Because the owner can change `data_access` at any time, a server-side check alone
is necessary but not sufficient: it runs against the *current* value, while a
reader page that loaded in `query` mode still holds queried rows in memory. An
author could therefore load a viewer with `query`, flip to `records`, and let the
page's retry loop submit those rows into `content_data_records` for the author to
read back — the exact loop the exclusivity is supposed to close.

So the mode is pinned per page load:

- `app/(protected)/c/[slug]/page.tsx` reads `data_access` when it renders and
  passes it to `<ArtifactSandbox dataAccess=…>` (unrecognized values collapse to
  `none`). It is a required member of the bridge-enabled prop branch, so no
  caller can enable the bridge without pinning a mode.
- `ArtifactSandbox` refuses any op that does not match that pinned mode *before*
  the Server Action is called, with the same generic failure as every other
  bridge refusal.
- The Server Actions still re-check the artifact's current mode
  (`assertArtifactDataAccess`).

Both layers must agree, so a mode flipped under an open page satisfies neither —
and the fresh load that would satisfy both starts with no queried data in memory.

## Viewer-scoped data queries (#1705)

```text
artifact code
  window.AtriumData.query(sql, { limit, offset })
        | postMessage {op:"query", sql, limit, offset}
        v
sandbox host -> ArtifactSandbox parent (event.source check, trusted contentId)
        | session-authenticated Server Action
        v
queryArtifactData
  - requires a session WITH a Cognito ID token (fails closed without one)
  - rate limits per viewer per artifact
  - contentService.get -> shared 404 mask; kind must be artifact; mode must be query
  - resolves the PSD data connector from the Nexus router config
        | getConnectorTools(serverId, viewer, roles, { idToken })  <- cognito_passthrough
        v
PSD Data MCP `query_data` (row-level security applied to the VIEWER)
```

The page supplies **exactly three fields**: `sql`, `limit`, `offset`. Everything
else is forced server-side and cannot be influenced from the frame:

| Argument | Value | Why |
|---|---|---|
| tool name | `query_data`, only | No write tool (`save_lesson`, `delete_lesson`, `rate_lesson`) is reachable. |
| `format` | `"json"` | Machine-usable rows instead of the chat Markdown table. |
| `export` | `false` | No CSV download link. The data MCP also rejects export in JSON mode. |
| `view_results` | `true` | — |
| `reason` | `atrium artifact <contentId> v<versionId>` | The data MCP audit log reads "this viewer, via artifact X". |

Bounds: SQL is capped at 8,000 characters, `limit` is clamped to 2,000 (the data
MCP's `JSON_ROW_LIMIT`), `offset` to 1,000,000, and the viewer gets 60 queries
per artifact per minute. The action allows a query 30s (matching the connector
service) rather than the records bridge's 10s, because each call is Lambda +
RDS. `requireUserAccess` runs inside `getConnectorTools`, so a student — or any
viewer outside the connector's allow list — is refused before any request
reaches the data MCP.

Every failure, from "not in query mode" to an upstream MCP error, reaches the
frame as the same generic rejection. Upstream text never leaves the server.

### Data MCP contract

`query_data` takes an optional `format` (default `"markdown"`, unchanged for
every existing caller). With `format: "json"` the text content is one object:

```json
{
  "columns": ["school_name", "enrolled"],
  "rows": [["Peninsula HS", 1234], ["Gig Harbor HS", 1210]],
  "total_count": 2,
  "returned_count": 2,
  "limit": 2000,
  "offset": 0,
  "truncated": false
}
```

Rows are arrays in `columns` order. Decimals become plain numbers, dates become
ISO 8601 strings, and NaN/None become `null`. JSON mode caps at
`JSON_ROW_LIMIT` (2,000) and `JSON_MAX_BYTES` (1 MiB, trimming rows and setting
`truncated`). RLS rewriting, the required `reason`, and audit logging run before
anything format-specific.

### Failure states a page must handle

- **No session / expired ID token.** ID tokens last about an hour; render a
  "reload the page to refresh your session" state.
- **No access to a table.** The agent writes the SQL but the viewer's permissions
  run it — a principal and a district admin see different rows, and a teacher
  without access to a table gets a rejection.
- **Rate limited.** Several queries per load is normal; a polling loop is not.
- **Public/embed/thumbnail surfaces.** `/p/<slug>`, embeds, and library
  thumbnails omit the bridge props, so `query` fails closed there by
  construction. The authoring surfaces do NOT (see "Where the bridge is live"):
  a draft can be exercised by its author before it is published.

## Artifact API

The sandbox host installs `window.AtriumData` before it executes artifact
scripts:

```ts
interface AtriumData {
  submit(
    namespace: string,
    payload: Record<string, unknown>
  ): Promise<{ id: string; createdAt: string }>;

  list(
    namespace: string,
    options?: { limit?: number; scope?: "all" | "mine" }
  ): Promise<{
    records: Array<{
      id: string;
      displayName: string;
      payload: Record<string, unknown>;
      createdAt: string;
    }>;
  }>;

  /** Requires data_access = "query". Rejects in every other mode. */
  query(
    sql: string,
    options?: { limit?: number; offset?: number }
  ): Promise<{
    columns: string[];
    /** Row tuples in `columns` order. */
    rows: unknown[][];
    totalCount: number;
    returnedCount: number;
    limit: number;
    offset: number;
    truncated: boolean;
  }>;
}
```

- Namespaces match `[a-z0-9_-]{1,64}`.
- Submission payloads are plain JSON objects no larger than 8 KiB. The reserved
  identity keys `userId` and `user_id` are rejected.
- List defaults to 50 newest-first records. Limits are floored and capped at
  200. `scope` defaults to `all`; `mine` filters to the session user.
- Calls reject on disabled bridge access, invalid input, timeout, rate limiting,
  visibility failure, or server failure. Artifacts must handle rejection.

Identity never comes from the artifact. The authenticated server session
supplies `user_id`, and reads derive `displayName` from that user record. An
artifact must not request a player name, accept a claimed identity in its
payload, or implement a profanity filter for names.

## postMessage protocol

Requests use a UUID request id and one of three operations:

```ts
type ArtifactDataRequest =
  | {
      type: "atrium-artifact-data-request";
      requestId: string;
      op: "submit";
      namespace: string;
      payload: Record<string, unknown>;
    }
  | {
      type: "atrium-artifact-data-request";
      requestId: string;
      op: "list";
      namespace: string;
      limit?: number;
      scope?: "all" | "mine";
    }
  | {
      // #1705 - carries no namespace; format/export/reason/tool are forced
      // server-side, so sending them from the frame changes nothing.
      type: "atrium-artifact-data-request";
      requestId: string;
      op: "query";
      sql: string;
      limit?: number;
      offset?: number;
    };
```

The parent returns exactly one correlated response:

```ts
type ArtifactDataResponse =
  | {
      type: "atrium-artifact-data-response";
      requestId: string;
      ok: true;
      data: unknown;
    }
  | {
      type: "atrium-artifact-data-response";
      requestId: string;
      ok: false;
      error: string;
    };
```

The host keeps at most 32 pending calls and applies a ten-second timeout
(forty-five seconds for `query`: the action's own 30s budget starts only after
authorization and the connector handshake, so the host must always outlast it
or a late server answer is dropped and the page retries a running query). The
parent independently bounds concurrent work and validates request ids,
namespaces, list options, JSON structure, and payload size before loading the
Server Action. The Server Action repeats authoritative validation.

The artifact never sends `contentId`. `ArtifactSandbox` copies only the allowed
request fields and supplies `contentId` from its own trusted props, preventing
artifact code from selecting another content object's records.

## Trust model and opaque origins

The iframe has `sandbox="allow-scripts"` without `allow-same-origin`. Its browser
origin is therefore opaque and serializes as `"null"` in a message event.
Checking `event.origin === "null"` would not authenticate this particular frame:
unrelated opaque-origin frames serialize the same way.

The parent authenticates a request with the browser-assigned WindowProxy:

```ts
event.source === iframe.contentWindow
```

The sandbox host applies the reciprocal check to responses:

```js
event.source === window.parent
```

Because an opaque-origin target has no usable concrete origin string, the two
sides send data messages with target origin `"*"`. This is safe only in
combination with the exact `event.source` checks, request-id correlation, fixed
message types, strict payload validation, and the parent-owned content id. The
host's initial render message still uses the existing allowlisted concrete app
origins; the data response path does not replace that render gate.

## CSP and unsupported persistence paths

The sandbox CSP remains unchanged: `default-src 'none'` and
`connect-src 'none'`. `postMessage` is browser messaging, not a network request,
so persistence does not require widening `connect-src`.

Consequently:

- `fetch()` and `XMLHttpRequest` cannot call AI Studio, Google, or another API.
- `localStorage` and `sessionStorage` throw in the opaque-origin frame and would
  not provide shared, cross-device persistence anyway.
- Google Forms/Sheets and Apps Script Web Apps cannot serve as a live artifact
  data source because consuming them requires a blocked network request.
- Baking a periodic Sheet snapshot into artifact HTML is stale by design and is
  not the live persistence architecture.

`AtriumData` preserves the sandbox's network-exfiltration boundary while moving
the authenticated operation into the trusted parent and server.

## Data model

`content_data_records` is append-only:

| Column | Shape | Behavior |
|---|---|---|
| `id` | UUID primary key | Generated per submission |
| `content_id` | UUID, required | References `content_objects`; cascades on content deletion |
| `namespace` | `varchar(64)`, required | Database check enforces `[a-z0-9_-]{1,64}` |
| `user_id` | integer, nullable | Session user; becomes null if that user is hard-deleted |
| `payload` | JSONB, required | Validated small plain-JSON object |
| `created_at` | `timestamptz`, required | Server timestamp, newest-first read ordering |

`content_objects.data_access` (migration 179) is a `content_data_access` enum —
`records` (default) | `query` | `none` — and is NOT NULL, so the backfill of
existing rows is the default itself.

The lookup index is `(content_id, namespace, created_at DESC)`. A second index on
`(user_id, content_id, namespace)` supports `scope: "mine"`. There is no update
column, retention timestamp, or sweep. Records remain until their parent content
object is deleted; deleting a user preserves records but clears attribution.

## Locked decisions from #1515

1. Display identity is the real authenticated session name. There is no alias
   layer.
2. Anonymous reads are not supported. The public `/p/<slug>` reader fails the
   bridge closed.
3. Bounds are sanity guards, not a quota system: payloads are at most 8 KiB,
   list limits are at most 200, and operations use the existing rate limiter.
   There is no per-content record ceiling or usage metering.
4. Records have no retention sweep and are not wired to the Nexus retention
   Lambda.
5. Google Apps Script enablement is deferred, not a substitute for this bridge.
   It cannot work as a live source inside the current sandbox and should be
   revisited only for a genuinely Workspace-native use case.
6. **Records and viewer-scoped queries can never coexist on one artifact
   (#1705).** Not a UX preference — it is the whole security argument. Records
   are readable by any viewer and by the author out-of-band, so an artifact that
   could both query as the viewer and submit records would give a hostile author
   an exfiltration loop through our own database (~8 KiB x 120/min). Do not relax
   this to "both for the owner" or "both for trusted authors": the guarantee has
   to hold regardless of author intent, which is exactly what removes the need
   for per-artifact review. Enforced by one shared `assertArtifactDataAccess`
   (`actions/db/atrium/artifact-guards.ts`), called from both
   `artifact-data.ts` and `artifact-query.ts`, so the two sides cannot drift.
7. Declared queries (storing SQL on the object with typed parameters) were
   considered and deferred. With no human reviewer in the loop they add audit
   legibility but no security, and they make dynamic filters harder to author.
   They can be layered on later without changing the bridge contract.
8. There is no admin approval gate for data-connected artifacts. Approval only
   helps against a malicious author, and with egress closed a malicious author
   cannot obtain anything the viewer sees.

## Agent usage

Artifact source uses `AtriumData.submit()` and `AtriumData.list()`. The PSD Agent
loads the `psd-atrium` skill for a complete leaderboard pattern and uses the
small command adapter for teacher-facing reads:

```bash
node /opt/psd-skills/psd-atrium/run.js list-data \
  --id <artifact-uuid-or-slug> \
  --namespace leaderboard \
  --limit 200
```

Do not create a second client framework and do not route this through Sheets,
browser storage, or a direct artifact network request.

For a live dashboard, set `dataAccess: "query"` on `create_artifact` and use
`AtriumData.query()` at runtime:

- **Never embed query results in the artifact source.** Baked-in rows are stale
  by design and are shown at the AUTHOR's permission level to every viewer — the
  exact problem this bridge exists to fix. The Code tab shows them verbatim.
- **Aggregate in SQL** so a chart query returns tens of rows, not a dataset.
  Each call is Lambda + RDS; do not ship full tables to the browser.
- **Page detail tables** with `limit`/`offset` instead of one huge read.
- **Pass filters as query parameters** and re-query when they change, rather than
  fetching everything once and filtering client-side.
- **Handle rejection.** A rejected `query()` means no session, an expired ID
  token, no access to a table, the wrong data-access mode, or a rate limit —
  render a sign-in / no-access state, never a blank chart.
