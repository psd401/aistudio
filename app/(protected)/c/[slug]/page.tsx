/**
 * Atrium internal reader page (RSC)
 *
 * Issue #1051 (Epic #1059, Atrium Phase 1, spec §18.2). Server-rendered reader
 * for a published intranet document at `/c/[slug]`. It resolves the object by
 * slug, confirms there is a *live* `intranet` publication, enforces the same
 * `canView` visibility gate as every other content read, then re-renders the
 * canonical markdown (`source.md`) through the sanitizing pipeline and shows a
 * provenance footer.
 *
 * ## Visibility gate (always 404, never 403)
 * - No object for the slug, or no live intranet publication -> `notFound()` (404).
 *   We do NOT leak "this exists but you can't see it" for the not-published case.
 * - Object exists and is published, but the requester fails `canView`
 *   (e.g. an out-of-building user for a building-scoped `group` document) ->
 *   ALSO `notFound()` (404). A non-viewable object must NOT 403: 403 confirms the
 *   slug exists, letting an out-of-audience or unauthenticated probe enumerate
 *   private document slugs by distinguishing 403 (exists) from 404 (absent). This
 *   matches the existence-masking contract enforced everywhere else in the content
 *   layer (see `publish-service.ts` `publish()` and `agent-bridge/route.ts`
 *   `loadEditableObject`, which both 404 a non-viewable object). Read access is
 *   bounded entirely by `visibilityService.canView` — the page is under
 *   `(protected)` so the route already requires a session, and
 *   `getOptionalRequester` resolves that session into the principal `canView`
 *   checks.
 *
 * ## Rendering / security
 * The markdown is re-rendered on every request from `source.md` through
 * `renderMarkdownToHtml`, which returns sanitized HTML (no `<script>`/`<style>`/
 * event handlers — see `lib/content/render/markdown-render.ts`). That output is
 * the only thing passed to `dangerouslySetInnerHTML`; raw author HTML never
 * reaches the DOM. If `source.md` is missing (e.g. S3 `NoSuchKey`), we render an
 * empty body rather than surfacing the raw S3 error.
 *
 * `dynamic = "force-dynamic"`: visibility depends on the caller's session, so the
 * page must never be statically cached or shared across principals.
 */

import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  contentObjects,
  contentPublications,
  contentVersions,
} from "@/lib/db/schema";
import { renderMarkdownToHtml } from "@/lib/content/render/markdown-render";
import { s3Store } from "@/lib/content/storage/s3-store";
import { visibilityService } from "@/lib/content/visibility-service";
import { getOptionalRequester } from "@/actions/db/atrium/requester";
import { createLogger } from "@/lib/logger";
import { ProvenanceFooter } from "@/components/atrium/ProvenanceFooter";
import "@/styles/atrium-content.css";
import "katex/dist/katex.min.css";

/**
 * Visibility depends on the session, so the reader must be rendered per-request
 * and never statically cached (a cached page would leak one principal's view to
 * another).
 */
export const dynamic = "force-dynamic";

interface ReaderPageProps {
  // Next 15+/16 App Router: dynamic route params are a Promise.
  params: Promise<{ slug: string }>;
}

/**
 * Load the object + live intranet publication for a slug, or `null` when there
 * is no such object or it is not published. Shared by the page and metadata so
 * the slug is resolved once per concern.
 */
async function loadPublishedObject(slug: string): Promise<{
  id: string;
  ownerUserId: number;
  visibilityLevel: "private" | "group" | "internal" | "public";
  title: string;
  publishedVersionId: string;
} | null> {
  const [obj] = await executeQuery(
    (db) =>
      db
        .select({
          id: contentObjects.id,
          ownerUserId: contentObjects.ownerUserId,
          visibilityLevel: contentObjects.visibilityLevel,
          title: contentObjects.title,
        })
        .from(contentObjects)
        .where(eq(contentObjects.slug, slug))
        .limit(1),
    "atrium.reader.objectBySlug"
  );
  if (!obj) return null;

  const [publication] = await executeQuery(
    (db) =>
      db
        .select({
          publishedVersionId: contentPublications.publishedVersionId,
        })
        .from(contentPublications)
        .where(
          and(
            eq(contentPublications.objectId, obj.id),
            eq(contentPublications.destination, "intranet"),
            eq(contentPublications.status, "live")
          )
        )
        .limit(1),
    "atrium.reader.livePublication"
  );
  if (!publication) return null;

  return { ...obj, publishedVersionId: publication.publishedVersionId };
}

/**
 * Page metadata: always returns a generic title. The real document title is NOT
 * exposed here because Next.js calls generateMetadata before the page component's
 * canView check runs — leaking a sensitive title (e.g. "H.R. Investigation #42")
 * to any authenticated user via tab bar, browser history, and link previews.
 */
export async function generateMetadata(_props: ReaderPageProps): Promise<Metadata> {
  // Intentionally does NOT resolve the slug — the real document title must not be
  // exposed here because canView hasn't run yet, and the title would leak via tab
  // bar, browser history, and link previews to any authenticated user.
  return { title: "Atrium Document" };
}

/**
 * The internal reader. See the file header for the full 403/404 decision tree.
 */
export default async function ReaderPage({
  params,
}: ReaderPageProps): Promise<React.JSX.Element> {
  const { slug } = await params;
  const log = createLogger({ action: "atrium.readerPage" });

  // (b)+(c) Object must exist AND have a live intranet publication, else 404.
  const published = await loadPublishedObject(slug);
  if (!published) {
    notFound();
  }

  // (d) Visibility gate. A published-but-not-viewable object (e.g. an
  // out-of-building user) 404s — NOT 403 — so its slug cannot be enumerated by
  // distinguishing "exists but forbidden" from "absent". `getOptionalRequester`
  // resolves the session into the principal `canView` evaluates.
  const requester = await getOptionalRequester();
  const viewable = await visibilityService.canView(requester, {
    id: published.id,
    ownerUserId: published.ownerUserId,
    visibilityLevel: published.visibilityLevel,
  });
  if (!viewable) {
    notFound();
  }

  // (e) Load the published version row for its version number, then read the
  // canonical markdown from S3 and render it through the sanitizing pipeline.
  const [version] = await executeQuery(
    (db) =>
      db
        .select({
          objectId: contentVersions.objectId,
          versionNumber: contentVersions.versionNumber,
        })
        .from(contentVersions)
        .where(eq(contentVersions.id, published.publishedVersionId))
        .limit(1),
    "atrium.reader.publishedVersion"
  );
  if (!version) {
    // The publication points at a version that no longer exists — treat as not
    // found rather than rendering an empty shell.
    notFound();
  }

  let markdown = "";
  try {
    const sourceKey = s3Store.key(
      version.objectId,
      version.versionNumber,
      "source.md"
    );
    markdown = await s3Store.getText(sourceKey);
  } catch (error) {
    // Missing/unreadable source (e.g. S3 NoSuchKey) degrades to an empty body
    // rather than surfacing the raw S3 error to the reader.
    log.warn("source.md unavailable; rendering empty body", {
      objectId: version.objectId,
      versionNumber: version.versionNumber,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // renderMarkdownToHtml returns SANITIZED HTML (see module header) — safe for
  // dangerouslySetInnerHTML; it is the only sink for the document body.
  const html = renderMarkdownToHtml(markdown);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-3xl font-semibold">{published.title}</h1>
      </header>
      {/* `.atrium-content` is the single rendered-body sink (and the test anchor). */}
      <article
        className="atrium-content"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <ProvenanceFooter objectId={published.id} />
    </main>
  );
}
