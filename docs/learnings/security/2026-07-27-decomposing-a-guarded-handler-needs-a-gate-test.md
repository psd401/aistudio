---
title: Splitting a handler that has one authorization gate requires a test pinning the gate for every branch
category: security
tags:
  - authorization
  - refactoring
  - agent-broker
  - atrium
  - capability
severity: high
date: 2026-07-27
source: auto — /lfg psd-sop-creator
applicable_to: project
---

## What Happened

`executeOwnerAtriumOperation` (`lib/agent-workspace/atrium-owner-operation.ts`)
is one function containing every route of the owner-bound Atrium agent broker.
Its structure carries a security property that is entirely **positional**:

```ts
// ...all GET branches...
await assertContentAuthoringCapability({ authType: "session", cognitoSub })
// ...all mutating branches...
```

Reads resolve above the line, writes below it. Adding four asset/source routes
pushed the function to complexity 58 across 283 lines, so it was decomposed into
`executeAtriumRead` / `executeContentWrite` / `executeMetadataWrite` /
`executeAssetWrite` / `executePublishWrite`.

That refactor is an improvement, but it converts an implicit positional
guarantee into an ordering convention across five call sites — and a new write
handler invoked above the gate would **not fail anything**. It would just work,
for a caller who is not permitted to author content.

## Root Cause

A guard expressed as "this statement sits between these two groups of code" has
no enforcement once the groups become separate functions. Nothing in the type
system or the tests referenced the relationship. The existing tests only proved
the gate ran for the two routes that happened to be new.

## Solution

Pin the property for **every** mutating route in one parameterized test: when
the capability check rejects, the result is 403 and no service is invoked.

```ts
it.each([
  ["POST", "", { kind: "document", title: "T" }],
  ["POST", "/content-1/versions", { body: "x" }],
  ["POST", "/content-1/assets", { /* … */ }],
  ["POST", "/content-1/assets/asset-1/complete", { /* … */ }],
  ["PATCH", "/content-1", { title: "T" }],
  ["PATCH", "/content-1/visibility", { level: "internal" }],
  ["DELETE", "/content-1", undefined],
  ["POST", "/content-1/publish", { destination: "intranet" }],
  ["DELETE", "/content-1/publish/intranet", undefined],
])("refuses %s %s when the authoring capability is denied", async (m, p, body) => {
  assertContentAuthoringCapabilityMock.mockRejectedValueOnce(new ForbiddenError())
  const result = await executeOwnerAtriumOperation({ /* … */ method: m, path: p, body })
  expect(result.httpStatus).toBe(403)
  for (const svc of [contentCreateMock, publishMock, assetInitiateMock, assetCompleteMock]) {
    expect(svc).not.toHaveBeenCalled()
  }
})
```

## Verify the test, not just the code

A security test that cannot fail is worse than none — it reads as proof. Run a
**negative control**: introduce the exact regression and confirm the test goes
red.

```ts
// temporarily, above the gate:
const early = await executeAssetWrite(req, input, segments, setAudit)
if (early) return early
```

→ 3 tests fail. Restore → 18 pass. Only then is the guarantee real.

## Prevention

- Before decomposing any handler containing an authz/authn/rate-limit gate,
  write the all-branches gate test **first**, then refactor against it.
- Treat "the check happens to be above/below this code" as an undocumented
  invariant: when the code moves, the invariant needs an explicit test or it is
  gone.
- Apply the same negative control to other positional guards in this codebase —
  idempotency checks inside a transaction, visibility-before-permission ordering
  (404 masking), and rate-limit reservations.
