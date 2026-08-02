# Atrium artifact data

Atrium artifact data is the first-party persistence path for sandboxed HTML/JS
artifacts. It lets an authenticated artifact append and list small JSON records
without giving untrusted code network access, cookies, storage, a content id, or
a reusable credential.

This document describes the implementation shipped by issues #1516–#1520 and
the agent guidance in #1521. The broader content, sandbox, visibility, and
publishing design remains in the [Atrium design specification](./atrium-design-spec.md).

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

The bridge is deliberately enabled only by a trusted authenticated reader that
has a content id. Preview, thumbnail, embed, full-screen preview, and anonymous
`/p/<slug>` callers omit the enabling props and therefore fail closed. Artifact
code must catch a rejected bridge call and present a state such as "Sign in to
see scores."

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

Requests use a UUID request id and one of two operations:

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

The host keeps at most 32 pending calls and applies a ten-second timeout. The
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
