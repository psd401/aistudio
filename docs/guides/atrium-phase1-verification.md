# Atrium Phase 1 — verification runbook (#1051)

Phase 1 ships the document path: a real-time collaborative editor (rebuilt from
Proof's ideas with TipTap + Yjs + Hocuspocus + Redis), the agent bridge, the
markdown render pipeline, the intranet publish layer, and the internal reader with
a provenance footer. This runbook lists what is verified automatically and how to
verify the live loop end to end.

## Architecture at a glance

- **Editor** — TipTap (ProseMirror) bound to a Yjs `Y.Doc` via `HocuspocusProvider`
  (`components/atrium/DocumentEditor.tsx`). Provenance is the `atriumAuthored`
  mark; the green/purple rail is a per-block node decoration
  (`provenance-rail.ts`), and local edits are stamped `human:<id>` by
  `authored-tracker.ts`.
- **Collab server** — a Hocuspocus instance (`lib/content/collab/collab-server.ts`)
  multiplexed onto the app's websocket transport at `/api/content/collab`
  (`server.ts` dev, `voice-server.js` prod). Auth is a short-TTL per-document token
  (`GET /api/content/[id]/collab`). State persists to Postgres
  (`atrium_doc_state`, migration 086); cross-task fan-out uses Redis when
  `REDIS_HOST` is set (local dev runs single-process without it).
- **Seeding** — on first open the server seeds the `Y.Doc` from the draft's
  markdown, stamped with the creator's author tag (agent draft → purple, human
  draft → green).
- **Agent bridge** — `POST /api/content/[id]/agent-bridge` (`X-Agent-Id` header)
  screens markdown through Bedrock Guardrails (+ PII detection telemetry) then
  diffs it into the live doc as `ai:<id>` (purple).
- **Render / reader / publish** — `lib/content/render/markdown-render.ts`
  (remark/rehype, strict sanitize, `:::callout`/`:::warn`, KaTeX) feeds the S3
  `render.html` snapshot and the reader; `app/(protected)/c/[slug]` is the
  visibility-gated reader; `lib/content/publish-service.ts` writes
  `content_publications`.

## Automated checks (run these)

```bash
bun run typecheck                      # 0 errors
bun run lint                           # touched files clean
bunx jest tests/unit/atrium-*.test.ts  # provenance + Phase 0 service contracts
bun run test:smoke:atrium-render       # remark/rehype pipeline (Bun, 9 checks)
bun run test:smoke:atrium-collab       # markdown<->Y.Doc round-trip + authorship (Bun, 4 checks)
bunx playwright test tests/e2e/atrium-document.guard.spec.ts   # route auth guards (401)
```

DB + seed-backed (needs local Docker postgres + the reference seed):

```bash
docker exec -i aistudio-postgres psql -U postgres -d aistudio \
  < tests/e2e/fixtures/atrium-reference-seed.sql
bun run test:smoke:atrium-visibility   # real canView: HS-staff allowed, out-of-building denied
```

## Manual: the live collaborative loop

Prereqs: migration 086 applied to the target DB; the dev server running with the
websocket wrapper (`bun run dev:voice`, host `:3100` per
`docs/guides/e2e-authenticated-testing.md`); optionally `REDIS_HOST`/`REDIS_PORT`
for multi-instance.

1. **Agent draft** — create a `document` content object with an initial markdown
   body (Phase 0 `createContentAction`, `created_by_actor='agent'`). This is the
   distilled one-pager.
2. **Open the editor** — visit `/atrium/<objectId>/edit`. The doc seeds from the
   draft; the whole body shows **purple** on the rail (agent-authored).
3. **Human edits** — type two lines. Those ranges turn **green** (`human:<id>`).
   Open the same URL in a second browser/profile to confirm edits sync live.
4. **Agent bridge (optional)** — `POST /api/content/<objectId>/agent-bridge` with
   `X-Agent-Id: ship-reporter` and `{ "markdown": "...", "mode": "replace" }`;
   connected editors see the change appear **purple** in real time. Unsafe content
   returns 422.
5. **Publish** — click **Publish** (or `publishDocumentAction`) to make the current
   version live on the intranet. Set the audience to group + building grant for the
   reference scenario.
6. **Read** — visit `/c/<slug>`:
   - an in-building (e.g. High School) staff user sees the rendered page + the
     provenance footer (**AI-drafted** + **Human-reviewed**);
   - an out-of-building user gets **403**.

The gated functional spec `tests/e2e/atrium-document-reference.spec.ts` automates
steps 5–6 once the reference seed + an authenticated host server are in place
(`PLAYWRIGHT_AUTH_ENABLED=true`).

## Production notes

- The collab server is bundled to a standalone CJS artifact
  (`scripts/build-collab-ws-handler.mjs`, built in the Dockerfile beside the voice
  bundle) and loaded by `voice-server.js`.
- Real-time co-editing of the **same** document across **multiple** ECS tasks
  requires Redis (`@hocuspocus/extension-redis`, enabled via `REDIS_HOST`). Without
  it, two users editing one doc on different tasks would diverge (no data loss —
  Postgres persists state). The ElastiCache wiring lands with this phase; confirm
  `REDIS_HOST`/`REDIS_PORT` reach the ECS task before relying on multi-task collab.
