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
 * ## Visibility gate (404 for non-viewers, redirect for viewers of unpublished)
 * - No object for the slug -> `notFound()` (404).
 * - Object exists, but the requester fails `canView`
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
 * - Object exists, the requester PASSES `canView`, but there is no live
 *   `intranet` publication -> `redirect()` to the object's authoring surface
 *   (`/atrium/{id}/view` for artifacts, `/atrium/{id}/edit` for documents — the
 *   same targets `contentSurfaceLink` hands out for drafts). This is the
 *   dead-link backstop: agents and API callers handed out `/c/{slug}` links for
 *   unpublished content (unconditionally before PR #1699; still today for a
 *   `status='published'` object whose only publication is `public_web`, or whose
 *   intranet publication was retracted). Those links live forever in chat
 *   histories and DMs; a viewer following one lands on the content they are
 *   already allowed to see instead of a dead 404. The mask is preserved: the
 *   redirect fires only AFTER `canView` passes, so an out-of-audience probe
 *   still cannot distinguish an unpublished slug from an absent one — which is
 *   also why `canView` now runs BEFORE the publication check.
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

import { notFound, redirect } from "next/navigation";
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
import { livePublicationConditions } from "@/lib/content/live-publication";
import { normalizeDataAccess } from "@/lib/content/types";
import type { ContentDataAccess } from "@/lib/content/types";
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
 * Load the object for a slug plus its live intranet publication (when one
 * exists), or `null` when there is no object at all. The publication is
 * nullable rather than collapsing "unpublished" into the absent case: the page
 * needs to tell the two apart so it can run the `canView`-gated dead-link
 * redirect for unpublished-but-viewable objects (see the file header).
 */
async function loadReaderObject(slug: string): Promise<{
  id: string;
  kind: "document" | "artifact";
  ownerUserId: number;
  collectionId: string | null;
  visibilityLevel: "private" | "group" | "internal" | "public";
  title: string;
  /** The object's collection name (via left join), for the reader meta line. */
  collectionName: string | null;
  /** Cover-gradient preset key + emoji icon (slice F) for the reader cover band. */
  coverGradient: string | null;
  icon: string | null;
  /**
   * The artifact's data-bridge mode AS OF THIS PAGE LOAD (#1712). Pinned into
   * `<ArtifactSandbox>` so a mode the owner flips while this page stays open
   * cannot be used by it — see the ArtifactSandbox header.
   */
  dataAccess: ContentDataAccess;
  /** The live intranet publication, or null when the object is not published there. */
  publication: {
    publishedVersionId: string;
    /** When the live intranet publication went live, for the "Published …" meta. */
    publishedAt: Date | null;
  } | null;
} | null> {
  const [obj] = await executeQuery(
    (db) =>
      db
        .select({
          id: contentObjects.id,
          kind: contentObjects.kind,
          ownerUserId: contentObjects.ownerUserId,
          collectionId: contentObjects.collectionId,
          visibilityLevel: contentObjects.visibilityLevel,
          title: contentObjects.title,
          // Left join → collection name (or null when the object is uncollected),
          // surfaced in the reader's "Published … · <collection>" meta. No extra
          // query: it rides on the existing slug lookup.
          collectionName: contentCollections.name,
          // Slice F cover band + emoji icon (migration 103).
          coverGradient: contentObjects.coverGradient,
          icon: contentObjects.icon,
          // #1705 data-bridge mode (migration 179), pinned per page load (#1712).
          dataAccess: contentObjects.dataAccess,
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
            // The same definition of Live the public reader, the sitemap and the
            // asset/embed gates use (#1726). Hand-writing
            // `destination = 'intranet'` here would have left THIS reader alone
            // in not accepting a pre-migration-180 `public_web` row: an object
            // live only through that alias would fall through to the dead-link
            // redirect for its own viewers during the deploy window, while
            // `/p/{slug}` served it happily.
            ...livePublicationConditions()
          )
        )
        .limit(1),
    "atrium.reader.livePublication"
  );

  return {
    ...obj,
    collectionName: obj.collectionName ?? null,
    // Fail closed on anything outside the enum (a value predating migration 179,
    // or a column widened later): unknown means "no bridge operations at all".
    // This raw-row read bypasses `rowToObjectDTO`, so it normalizes here.
    dataAccess: normalizeDataAccess(obj.dataAccess),
    publication: publication
      ? {
          publishedVersionId: publication.publishedVersionId,
          publishedAt: publication.publishedAt ?? null,
        }
      : null,
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

  // (b) Object must exist, else 404. `loadReaderObject` (a DB lookup) and
  // `getOptionalRequester` (a session lookup) are independent, so run them
  // concurrently — under Aurora Serverless v2 with dev auto-pause, cold-start
  // connection latency would otherwise stack serially on every reader render.
  // The session lookup is cheap and wasted only on the (rare) 404 path; the
  // visibility gate below still 404s before using it.
  // `target`, not `published`: past gate (d) below it is guaranteed to carry a
  // live publication, but before it the object may well be an unpublished one.
  const [target, requester] = await Promise.all([
    loadReaderObject(slug),
    getOptionalRequester(),
  ]);
  if (!target) {
    notFound();
  }

  // (c) Visibility gate — deliberately BEFORE the publication check, so an
  // unpublished slug stays indistinguishable from an absent one for
  // out-of-audience probes. A not-viewable object (e.g. an out-of-building
  // user) 404s — NOT 403 — so its slug cannot be enumerated by distinguishing
  // "exists but forbidden" from "absent". `getOptionalRequester` resolves the
  // session into the principal `canView` evaluates.
  const viewable = await visibilityService.canView(requester, {
    id: target.id,
    ownerUserId: target.ownerUserId,
    collectionId: target.collectionId,
    visibilityLevel: target.visibilityLevel,
  });
  if (!viewable) {
    notFound();
  }

  // (d) Dead-link backstop (see file header): viewable but no live intranet
  // publication -> redirect to the authoring surface, mirroring
  // `contentSurfaceLink`'s draft targets. `redirect()` throws, so past this
  // gate a live publication is guaranteed.
  if (!target.publication) {
    redirect(
      `/atrium/${target.id}/${target.kind === "artifact" ? "view" : "edit"}`
    );
  }

  // (e) Load the published version (object-scoped) for its body. Documents read
  // their canonical markdown from S3; artifacts resolve their untrusted code
  // (inline or S3) for the cross-origin sandbox.
  const version = await versionService.getById(
    target.id,
    target.publication.publishedVersionId
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
  const editHref = canEdit(requester, target.ownerUserId)
    ? `/atrium/${target.id}/edit`
    : null;

  // Editors-only comment chip count. Only read when the viewer may edit (the chip
  // is editor-gated) so a non-editor render never issues the comments query.
  const commentCount = editHref ? await unresolvedCommentCount(target.id) : 0;

  // ARTIFACT reader: load the untrusted code server-side and render it ONLY in
  // the cross-origin sandbox. The code is never placed in app-origin HTML.
  if (target.kind === "artifact") {
    // Missing/unreadable body degrades to an empty preview (never the raw S3
    // error) — the shared loadArtifactCodeSafe contract.
    const code = await versionService.loadArtifactCodeSafe(version);
    return (
      <ReaderFrame
        title={target.title}
        authenticated
        editHref={editHref}
        commentHref={editHref}
        commentCount={commentCount}
        // The chrome-free viewer, reachable in ONE click from here for every
        // viewer. Previously the only route was Edit → "Open full screen",
        // which put an editing surface in front of a read-only action and left
        // non-editors with no route at all. `/atrium/[id]/view` re-runs its own
        // `canView` server-side, so this link grants nothing.
        fullScreenHref={`/atrium/${target.id}/view`}
        publishedAt={target.publication.publishedAt}
        collectionName={target.collectionName}
        // Artifact readers skip the TOC (no document headings to walk).
        headings={[]}
        // Full-bleed: the interactive artifact fills the viewport instead of the
        // 720px reading sheet (#1052).
        fullBleed
        footer={
          <ProvenanceFooter
            objectId={target.id}
            publishedVersionNumber={version.versionNumber}
          />
        }
      >
        <ArtifactSandbox
          // #1712: the mode pin below lives in a ref for the mount's lifetime, so
          // the mount MUST belong to exactly one artifact. Keying on the id makes
          // that true by construction — a different artifact is a fresh mount and
          // a fresh pin — instead of relying on the router remounting the leaf
          // page on a param change (same pattern as ArtifactCanvas's version key).
          key={target.id}
          code={code}
          src={getArtifactSandboxRenderUrl()}
          dataBridgeEnabled={true}
          contentId={target.id}
          // #1712: the mode read for THIS render. The sandbox refuses any op
          // that does not match it, so an owner flipping `data_access` under an
          // open page cannot reopen the records/query exfiltration loop; the
          // Server Actions still re-check the artifact's current mode.
          dataAccess={target.dataAccess}
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
      title={target.title}
      authenticated
      editHref={editHref}
      commentHref={editHref}
      commentCount={commentCount}
      publishedAt={target.publication.publishedAt}
      collectionName={target.collectionName}
      headings={headings}
      coverGradient={target.coverGradient}
      icon={target.icon}
      footer={
        <ProvenanceFooter
          objectId={target.id}
          publishedVersionNumber={version.versionNumber}
        />
      }
    >
      {/* `.atrium-content` is the single rendered-body sink (and the test anchor). */}
      <ReaderDocumentBody parts={parts} />
    </ReaderFrame>
  );
}
