/**
 * Dev helper (#1051): seed live collab state + S3 body for the reference doc so
 * the Playwright verification has real content to render. Not used in prod.
 *
 * Run (local DB):
 *   DATABASE_URL='postgresql://postgres:postgres@localhost:5432/aistudio' DB_SSL=false \
 *     bun run scripts/dev/seed-atrium-doc-state.ts
 */
import * as Y from "yjs";
import { seedYDocFromMarkdown } from "@/lib/content/collab/markdown-bridge";
import { saveDocState } from "@/lib/content/collab/doc-state-store";
import { makeAuthorTag } from "@/lib/content/collab/provenance";
import { s3Store } from "@/lib/content/storage/s3-store";
import { renderMarkdownToHtml } from "@/lib/content/render/markdown-render";

const OBJECT_ID = "a7100000-0000-4000-8000-000000004040";
const PUBLISHED_VERSION_NUMBER = 2;

const MD = `# Board Procedure 4040 — One-pager

This distilled summary was drafted by the **ship-reporter** agent from the source PDF.

:::callout
Staff must review this procedure annually and acknowledge in the HR portal.
:::

:::warn
The acknowledgement deadline is the last instructional day of the school year.
:::

## Scope

Applies to all High School staff. See the district handbook for the full policy.`;

const by = makeAuthorTag("agent", "ship-reporter");
const doc = seedYDocFromMarkdown(MD, by);
await saveDocState(OBJECT_ID, Y.encodeStateAsUpdate(doc), MD);
console.log(`[seed] atrium_doc_state seeded for ${OBJECT_ID} (agent-authored)`);

// Best-effort S3 body so the reader renders the markdown (skips gracefully if S3
// is unreachable locally — the reader falls back to an empty article).
try {
  await s3Store.putText(
    s3Store.key(OBJECT_ID, PUBLISHED_VERSION_NUMBER, "source.md"),
    MD,
    "text/markdown"
  );
  await s3Store.putText(
    s3Store.key(OBJECT_ID, PUBLISHED_VERSION_NUMBER, "render.html"),
    renderMarkdownToHtml(MD),
    "text/html",
    "attachment"
  );
  console.log(`[seed] S3 source.md + render.html written for v${PUBLISHED_VERSION_NUMBER}`);
} catch (error) {
  console.warn(`[seed] S3 write skipped: ${error instanceof Error ? error.message : String(error)}`);
}

process.exit(0);
