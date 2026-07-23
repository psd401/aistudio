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
 * - DOCUMENTS: the markdown is re-rendered on every request from `source.md`
 *   through `renderMarkdownToHtml`, which returns sanitized HTML (no
 *   `<script>`/`<style>`/event handlers — see
 *   `lib/content/render/markdown-render.ts`). That output is the only thing
 *   passed to `dangerouslySetInnerHTML`; raw author HTML never reaches the DOM.
 *   If `source.md` is missing (e.g. S3 `NoSuchKey`), we render an empty body
 *   rather than surfacing the raw S3 error.
 * - ARTIFACTS (#1052): the UNTRUSTED artifact code is loaded server-side
 *   (inline or S3) and handed to the client `<ArtifactSandbox>`, which renders it
 *   in a cross-origin sandboxed iframe (`sandbox="allow-scripts"`, no
 *   `allow-same-origin`) served from a separate origin (§19.2 / §28.1). The code
 *   is NEVER passed to `dangerouslySetInnerHTML` or served as text/html on the
 *   app origin — the public reader applies the same containment.
 *
 * ## Reader chrome (Epic #1059 Meridian redesign, slice E)
 * The body is wrapped in `<ReaderFrame>` (the Meridian published-page shell — screen
 * 2c): a branded "{org} Intranet" top nav (with the viewer's avatar), a left "ON
 * THIS PAGE" TOC built from the document's headings, and the reading sheet with a
 * "Published … · <collection>" meta + "UP TO DATE" pill.
 * - An owner/editor-gated "Edit" link (the same `canEdit` predicate the authoring
 *   page's save controls use) renders in the sheet header; non-editors instead see
 *   an explicit "👁 View only" notice.
 *
 * `dynamic = "force-dynamic"`: visibility depends on the caller's session, so the
 * page must never be statically cached or shared across principals.
 */

import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { executeQuery } from "@/lib/db/drizzle-client";
import {
  contentCollections,
  contentObjects,
  contentPublications,
} from "@/lib/db/schema";
import { s3Store } from "@/lib/content/storage/s3-store";
import { visibilityService } from "@/lib/content/visibility-service";
import { versionService } from "@/lib/content/version-service";
import { resolveDocumentParts } from "@/lib/content/embed-resolver";
import { extractDocumentHeadings } from "@/lib/content/render/headings";
import { canEdit } from "@/lib/content/helpers";
import { getOptionalRequester } from "@/actions/db/atrium/requester";
import { countUnresolvedCommentThreadsAction } from "@/actions/db/atrium/comments";
import { createLogger } from "@/lib/logger";
import { ProvenanceFooter } from "@/components/atrium/ProvenanceFooter";
import { ArtifactSandbox } from "@/components/atrium/ArtifactSandbox";
import { ReaderDocumentBody } from "@/components/atrium/ReaderDocumentBody";
import { ReaderFrame } from "@/components/atrium/reader/ReaderFrame";
import { getArtifactSandboxRenderUrl } from "@/lib/content/artifact-sandbox-config";
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
  kind: "document" | "artifact";
  ownerUserId: number;
  visibilityLevel: "private" | "group" | "internal" | "public";
  title: string;
  /** The object's collection name (via left join), for the reader meta line. */
  collectionName: string | null;
  /** Cover-gradient preset key + emoji icon (slice F) for the reader cover band. */
  coverGradient: string | null;
  icon: string | null;
  publishedVersionId: string;
  /** When the live intranet publication went live, for the "Published …" meta. */
  publishedAt: Date | null;
} | null> {
  const [obj] = await executeQuery(
    (db) =>
      db
        .select({
          id: contentObjects.id,
          kind: contentObjects.kind,
          ownerUserId: contentObjects.ownerUserId,
          visibilityLevel: contentObjects.visibilityLevel,
          title: contentObjects.title,
          // Left join → collection name (or null when the object is uncollected),
          // surfaced in the reader's "Published … · <collection>" meta. No extra
          // query: it rides on the existing slug lookup.
          collectionName: contentCollections.name,
          // Slice F cover band + emoji icon (migration 103).
          coverGradient: contentObjects.coverGradient,
          icon: contentObjects.icon,
        })
        .from(contentObjects)
        .leftJoin(
          contentCollections,
          eq(contentCollections.id, contentObjects.collectionId)
        )
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
          publishedAt: contentPublications.publishedAt,
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

  return {
    ...obj,
    collectionName: obj.collectionName ?? null,
    publishedVersionId: publication.publishedVersionId,
    publishedAt: publication.publishedAt ?? null,
  };
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
 * Unresolved root-comment count for the editors-only reader chip. Uses the cheap
 * COUNT action (backed by idx_adc_object_resolved) — NOT listCommentThreadsAction,
 * which would load + serialize every comment body just to size a number on the hot
 * reader render. Degrades to 0 on any failure so a comments outage never breaks the
 * reader.
 */
async function unresolvedCommentCount(idOrSlug: string): Promise<number> {
  try {
    const result = await countUnresolvedCommentThreadsAction(idOrSlug);
    return result.isSuccess ? result.data : 0;
  } catch {
    return 0;
  }
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
  // `loadPublishedObject` (a DB lookup) and `getOptionalRequester` (a session
  // lookup) are independent, so run them concurrently — under Aurora Serverless
  // v2 with dev auto-pause, cold-start connection latency would otherwise stack
  // serially on every reader render. The session lookup is cheap and wasted only
  // on the (rare) 404 path; the visibility gate below still 404s before using it.
  const [published, requester] = await Promise.all([
    loadPublishedObject(slug),
    getOptionalRequester(),
  ]);
  if (!published) {
    notFound();
  }

  // (d) Visibility gate. A published-but-not-viewable object (e.g. an
  // out-of-building user) 404s — NOT 403 — so its slug cannot be enumerated by
  // distinguishing "exists but forbidden" from "absent". `getOptionalRequester`
  // resolves the session into the principal `canView` evaluates.
  const viewable = await visibilityService.canView(requester, {
    id: published.id,
    ownerUserId: published.ownerUserId,
    visibilityLevel: published.visibilityLevel,
  });
  if (!viewable) {
    notFound();
  }

  // (e) Load the published version (object-scoped) for its body. Documents read
  // their canonical markdown from S3; artifacts resolve their untrusted code
  // (inline or S3) for the cross-origin sandbox.
  const version = await versionService.getById(
    published.id,
    published.publishedVersionId
  );
  if (!version) {
    // The publication points at a version that no longer exists — treat as not
    // found rather than rendering an empty shell.
    notFound();
  }

  // Owner/editor-gated Edit link (Epic #1059 completion): the SAME `canEdit`
  // predicate the authoring page uses (owner / admin / delegated-for-owner).
  // A guest requester (userId null) can never pass it. Computed only AFTER the
  // visibility gate above, so it never runs for a masked object.
  const editHref = canEdit(requester, published.ownerUserId)
    ? `/atrium/${published.id}/edit`
    : null;

  // Editors-only comment chip count. Only read when the viewer may edit (the chip
  // is editor-gated) so a non-editor render never issues the comments query.
  const commentCount = editHref ? await unresolvedCommentCount(published.id) : 0;

  // ARTIFACT reader: load the untrusted code server-side and render it ONLY in
  // the cross-origin sandbox. The code is never placed in app-origin HTML.
  if (published.kind === "artifact") {
    // Missing/unreadable body degrades to an empty preview (never the raw S3
    // error) — the shared loadArtifactCodeSafe contract.
    const code = await versionService.loadArtifactCodeSafe(version);
    return (
      <ReaderFrame
        title={published.title}
        authenticated
        editHref={editHref}
        commentHref={editHref}
        commentCount={commentCount}
        publishedAt={published.publishedAt}
        collectionName={published.collectionName}
        // Artifact readers skip the TOC (no document headings to walk).
        headings={[]}
        // Full-bleed: the interactive artifact fills the viewport instead of the
        // 720px reading sheet (#1052).
        fullBleed
        footer={
          <ProvenanceFooter
            objectId={published.id}
            publishedVersionNumber={version.versionNumber}
          />
        }
      >
        <ArtifactSandbox
          code={code}
          src={getArtifactSandboxRenderUrl()}
          className="atrium-artifact-reader-frame"
        />
      </ReaderFrame>
    );
  }

  // DOCUMENT reader: read the canonical markdown from S3 and render it through
  // the sanitizing pipeline.
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

  // Render the body as ordered parts: sanitized-HTML runs (the same
  // renderMarkdownToHtml sink) interleaved with live embedded-artifact blocks. Each
  // embed is resolved on the ARTIFACT's own visibility for THIS viewer (internal
  // audience → canView) — a non-viewable embed renders a quiet placeholder, never
  // its content.
  const parts = await resolveDocumentParts(markdown, {
    audience: "internal",
    requester,
  });

  // "ON THIS PAGE" TOC — built server-side from the document's own headings, with
  // ids matching the rendered `<h1..h3>` (rehype-slug). Empty when the body is
  // empty (e.g. S3 unavailable) → the TOC simply doesn't render.
  const headings = extractDocumentHeadings(markdown);

  return (
    <ReaderFrame
      title={published.title}
      authenticated
      editHref={editHref}
      commentHref={editHref}
      commentCount={commentCount}
      publishedAt={published.publishedAt}
      collectionName={published.collectionName}
      headings={headings}
      coverGradient={published.coverGradient}
      icon={published.icon}
      footer={
        <ProvenanceFooter
          objectId={published.id}
          publishedVersionNumber={version.versionNumber}
        />
      }
    >
      {/* `.atrium-content` is the single rendered-body sink (and the test anchor). */}
      <ReaderDocumentBody parts={parts} />
    </ReaderFrame>
  );
}
