# Edge Runtime Boundaries

Guidance for code that is reachable from `middleware.ts`. Written after #1297,
where a Node-only logger reached the Edge bundle and silently broke session
continuity for three hours of every twelve-hour session.

## What actually runs on Edge

`middleware.ts` is compiled for the **Next.js Edge Runtime sandbox** — including
in our self-hosted `output: 'standalone'` Node deployment on ECS. The sandbox is
not Node: it exposes a fixed allowlist of native modules and rejects everything
else at `require` time with

```
TypeError: Native module not found: <pkg>
```

Because `middleware.ts` imports `@/auth`, **the entire NextAuth config is Edge
code**, and so is everything its callbacks touch:

```
middleware.ts
  └── @/auth (authConfig — jwt & session callbacks)
        └── @/lib/auth/token-refresh-client
              └── @/lib/auth/cognito-refresh   ← must stay Edge-safe
```

## The rule

Anything reachable from that graph may use only Edge primitives: `fetch`, `URL`,
`JSON`, `Date`, `crypto.subtle`, `process.env`. In particular:

| Don't | Do |
| --- | --- |
| `@/lib/logger` (imports `winston`) | `@/lib/auth/edge-logger` |
| `@aws-sdk/client-*` | `fetch` against the service's HTTP API |
| `node:crypto`, `node:fs`, `node:async_hooks` | Web Crypto / nothing |

`winston` is listed in `serverExternalPackages` in `next.config.mjs`, so it
compiles to a bare `require("winston")` rather than being inlined — which is
exactly what the sandbox refuses.

## The trap: `await import()` is not a runtime boundary

This looks like it defers to Node. It does not:

```ts
// ❌ Still bundled into the Edge chunk — the specifier is static, so the
//    bundler follows it and pulls the whole subgraph in.
const { refreshCognitoToken } = await import("@/actions/auth/refresh-token-action")
```

Two separate misconceptions combine here:

1. **A dynamic import with a static specifier is still bundled** into the
   *importing* runtime's chunk. Dynamic only defers *evaluation*, not bundling.
2. **A `"use server"` action is only an RPC call when a _client_ component
   imports it.** Imported from server or Edge code, the real implementation is
   inlined and runs in the caller's runtime.

Together they meant `refresh-token-action.ts` — with its `@/lib/logger` and
`@aws-sdk/client-cognito-identity-provider` imports — was compiled into
`middleware.js`. Every proactive or post-expiry refresh threw, the JWT callback
returned `null`, and the user was bounced to sign-in.

## How to actually cross into Node

Pick one:

- **Best — do the work with Edge primitives.** Most AWS JSON APIs are plain
  HTTP. `lib/auth/cognito-refresh.ts` calls Cognito's `InitiateAuth`
  (`REFRESH_TOKEN_AUTH`) with `fetch`; the flow is unauthenticated for a public
  app client, so no SigV4 and no SDK are needed.
- **Otherwise — make it a real network hop.** A Route Handler with
  `export const runtime = "nodejs"`, called over HTTP. A function call is never
  a runtime boundary; a request is.
- **Last resort — guard and degrade.** If a Node-only side effect is genuinely
  best-effort, skip it explicitly on Edge instead of relying on a `try/catch`
  around a load that was never going to succeed:

  ```ts
  if (typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime !== "undefined") return
  ```

  `auth.ts` does this for the Secrets Manager refresh-token mirror.

## Regression guard

`tests/unit/lib/auth/edge-refresh-boundary.test.ts` walks the static import
graph from `lib/auth/token-refresh-client.ts` and fails if it reaches `winston`,
`@/lib/logger`, `@aws-sdk/*`, `node:*`, or `@/actions/*`. It runs in normal CI
(`bun run test:ci`) with no build step, so a regression is caught on the PR that
introduces it.

If you add a module to the Edge auth graph, it is covered automatically. If you
create a *new* Edge entrypoint, add it to that test's entry list.

## Why this class of bug is so quiet

The failure needs a session old enough to enter the refresh window, so it never
reproduces in a fresh `next dev` session or a smoke test that just signed in. It
surfaces as "users randomly get logged out". When triaging session-continuity
complaints, search CloudWatch for `Native module not found` before anything else.
