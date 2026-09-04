/**
 * Atrium public reader page (RSC, anonymous)
 *
 * Issue #1057 (Epic #1059, Atrium Phase 7, spec §20 / §26.4). The world-readable
 * twin of the internal `/c/[slug]` reader. It resolves a slug, confirms the
 * object is LIVE, enforces `visibility_level = 'public'`, then renders the SAME
 * sanitized markdown (`source.md`) or the SAME cross-origin artifact sandbox as
 * the internal reader, plus a provenance footer.
 *
 * ## The public address is DERIVED (#1726)
 * `Public + Live` IS the public page — there is no separate "publish to the
 * public web" switch to remember, and therefore no way for the two to disagree.
 * The gate is the same conjunction it always enforced, minus the second row.
 *
 * ## Anonymous by design — public means public, for EVERYONE
 * This route is in `PUBLIC_PATHS` (middleware) so no session is required. Unlike
 * the internal reader — which uses `canView(session-principal)` and can therefore
 * surface `group`/`internal` content to an in-audience viewer — the PUBLIC reader
 * gates STRICTLY on `visibility_level === 'public'` and does NOT consult any
 * session. Rationale: `/p/[slug]` is a public surface; it must serve the SAME
 * thing to an anonymous visitor and to a logged-in staff member. Gating on
 * `canView(session)` here would leak non-public content to authenticated users
 * through the public URL (e.g. an `internal` object that is Live but whose Level
 * is still `internal`). `visibility_level ===
 * 'public'` is the object-level world-readable predicate. A fixed anonymous
 * requester is additionally checked against the object's collection so an
 * archived or grant-restricted district collection cannot remain public through
 * a stale `/p/` publication.
 *
 * ## Visibility gate (always 404, never 403)
 * No object for the slug, no live publication, OR a non-`public`
 * object ALL resolve to `notFound()` (404). We never 403 (which would confirm a
 * slug exists and let a probe enumerate private slugs) — the existence-masking
 * contract enforced everywhere else in the content layer.
 *
 * ## Rendering / security
 * Identical containment to the internal reader:
 * - DOCUMENTS: `source.md` is re-rendered per request through
 *   `renderMarkdownToHtml`, which returns SANITIZED HTML (no `<script>`/event
 *   handlers). That output is the only thing passed to `dangerouslySetInnerHTML`.
 * - ARTIFACTS (#1052): the untrusted code is loaded server-side and handed to the
 *   client `<ArtifactSandbox>`, which renders it in a cross-origin sandboxed
 *   iframe (`sandbox="allow-scripts"`, no `allow-same-origin`) served from a
 *   separate origin. The code is NEVER placed in app-origin HTML.
 *
 * `dynamic = "force-dynamic"`: the live publication + version are read per request
 * so an unpublish takes effect immediately (a cached page must never outlive the
 * publication that authorized it).
 */

import { cache } from "react";
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
import { versionService } from "@/lib/content/version-service";
import { resolveDocumentParts } from "@/lib/content/embed-resolver";
import { requesterMayViewCollection } from "@/lib/content/collection-access";
import { livePublicationConditions } from "@/lib/content/live-publication";
import { extractDocumentHeadings } from "@/lib/content/render/headings";
import type { Requester } from "@/lib/content/types";
import { createLogger } from "@/lib/logger";
import { ProvenanceFooter } from "@/components/atrium/ProvenanceFooter";
import { ArtifactSandbox } from "@/components/atrium/ArtifactSandbox";
import { ReaderDocumentBody } from "@/components/atrium/ReaderDocumentBody";
import { ReaderFrame } from "@/components/atrium/reader/ReaderFrame";
import { getArtifactSandboxRenderUrl } from "@/lib/content/artifact-sandbox-config";
import "@/styles/atrium-content.css";
import "katex/dist/katex.min.css";

/**
 * The live publication + version are read per request; a cached page must never
 * outlive the publication that authorized it (an unpublish must 404 immediately).
 */
export const dynamic = "force-dynamic";

interface PublicReaderPageProps {
  // Next 15+/16 App Router: dynamic route params are a Promise.
  params: Promise<{ slug: string }>;
}

const ANONYMOUS_REQUESTER: Requester = {
  kind: "user",
  userId: null,
  roles: [],
  groups: [],
  isAdmin: false,
};

/**
 * Load the object + its live publication for a slug, but ONLY when the
 * object's visibility is `public`. Returns `null` otherwise (absent slug, no live
 * publication, or a non-public object) — the single "may this be shown
 * on the public route?" decision, shared by the page and metadata so the strict
 * public gate is applied exactly once and identically in both.
 *
 * Wrapped in React `cache` so the (up to two) DB reads run once per request even
 * though both `generateMetadata` and the page component call it with the same slug.
 */
const loadPublicObject = cache(async (
  slug: string
): Promise<{
  id: string;
  kind: "document" | "artifact";
  title: string;
  collectionId: string | null;
  /** The object's collection name (via left join), for the reader meta line. */
  collectionName: string | null;
  /** Cover-gradient preset key + emoji icon (slice F) for the reader cover band. */
  coverGradient: string | null;
  icon: string | null;
  publishedVersionId: string;
  /** When the object went live, for the "Published …" meta. */
  publishedAt: Date | null;
} | null> => {
  const [obj] = await executeQuery(
    (db) =>
      db
        .select({
          id: contentObjects.id,
          kind: contentObjects.kind,
          title: contentObjects.title,
          collectionId: contentObjects.collectionId,
          visibilityLevel: contentObjects.visibilityLevel,
          // Left join → collection name (or null), for the reader meta. Rides on
          // the existing slug lookup — no extra query and no session read.
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
    "atrium.publicReader.objectBySlug"
  );
  if (!obj) return null;

  // STRICT public gate: the public route serves ONLY world-readable content.
  // A non-public object (even one that is Live while its visibility
  // stayed internal/group) is treated as absent — 404, never 403.
  if (obj.visibilityLevel !== "public") return null;
  if (
    !(await requesterMayViewCollection(
      ANONYMOUS_REQUESTER,
      obj.collectionId
    ))
  ) {
    return null;
  }

  // The public page is DERIVED (#1726): Public + Live, not a second publication
  // row the author has to remember to create. `livePublicationConditions` is the
  // one definition of Live, shared with the sitemap / embed / asset gates.
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
            ...livePublicationConditions()
          )
        )
        .limit(1),
    "atrium.publicReader.livePublication"
  );
  if (!publication) return null;

  return {
    id: obj.id,
    kind: obj.kind,
    title: obj.title,
    collectionId: obj.collectionId,
    collectionName: obj.collectionName ?? null,
    coverGradient: obj.coverGradient,
    icon: obj.icon,
    publishedVersionId: publication.publishedVersionId,
    publishedAt: publication.publishedAt ?? null,
  };
});

/**
 * Load the published version for a gate-passing object. Wrapped in React `cache`
 * so `generateMetadata` (which reads the version summary for the description) and
 * the page body (which reads the version for rendering) share ONE DB read per
 * request instead of two.
 */
const loadPublishedVersion = cache(
  async (objectId: string, versionId: string) =>
    versionService.getById(objectId, versionId)
);

/**
 * Page metadata. Title/description/OG tags are resolved ONLY for an object that
 * passes the public gate (public visibility + Live) —
 * its title and published-version summary are world-readable by definition, so
 * exposing them in the tab/link preview leaks nothing. Anything that fails the
 * gate gets a generic title and NO other metadata, so a probe cannot distinguish
 * a private slug from an absent one via metadata either.
 *
 * This route is intentionally public (spec §20), so robots are explicitly
 * index/follow — the SEO surface for public pages (with /sitemap.xml
 * enumerating the same gate-passing set).
 */
export async function generateMetadata({
  params,
}: PublicReaderPageProps): Promise<Metadata> {
  const { slug } = await params;
  const published = await loadPublicObject(slug);
  if (!published) {
    // Masked: generic title only — no description, no OG, no robots directive
    // that could differentiate "exists but non-public" from "absent".
    return { title: "Atrium" };
  }
  // Description comes from the PUBLISHED version's change summary (the only
  // world-readable per-version text) — never a draft/head version, which may be
  // newer than what the public page renders.
  const version = await loadPublishedVersion(
    published.id,
    published.publishedVersionId
  );
  const description = version?.summary?.trim() || undefined;
  return {
    title: published.title,
    description,
    openGraph: {
      title: published.title,
      description,
      type: "article",
    },
    robots: { index: true, follow: true },
  };
}

/**
 * The public reader. See the file header for the full anonymous/404 decision tree.
 */
export default async function PublicReaderPage({
  params,
}: PublicReaderPageProps): Promise<React.JSX.Element> {
  const { slug } = await params;
  const log = createLogger({ action: "atrium.publicReaderPage" });

  // Object must exist, be `public`, AND be Live, else
  // 404. No session is consulted — the gate is entirely visibility-based.
  const published = await loadPublicObject(slug);
  if (!published) {
    notFound();
  }

  // Load the published version (object-scoped) for its body. Shared (React
  // `cache`) with generateMetadata, which reads the same version's summary.
  const version = await loadPublishedVersion(
    published.id,
    published.publishedVersionId
  );
  if (!version) {
    // The publication points at a version that no longer exists — treat as not
    // found rather than rendering an empty shell.
    notFound();
  }

  // ARTIFACT reader: load the untrusted code server-side and render it ONLY in
  // the cross-origin sandbox. The code is never placed in app-origin HTML.
  if (published.kind === "artifact") {
    // Missing/unreadable body degrades to an empty preview (never the raw S3
    // error) — the shared loadArtifactCodeSafe contract.
    const code = await versionService.loadArtifactCodeSafe(version);
    // A publicly shared artifact is just the page itself: no intranet nav, no
    // title bar, no "UP TO DATE" pill, no provenance footer. Anyone outside the
    // district following this link should get the artifact and nothing else —
    // the surrounding chrome advertised an intranet they cannot enter.
    //
    // Same shape as /atrium/[id]/view: a fixed, full-viewport container holding
    // only the cross-origin sandbox. Delivery is unchanged — the untrusted code
    // still never touches app-origin HTML — and `dataBridgeEnabled` stays unset
    // so anonymous bridge access remains impossible at the type boundary.
    return (
      <div
        data-testid="artifact-viewport"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 50,
          background: "#fff",
        }}
      >
        <ArtifactSandbox
          code={code}
          src={getArtifactSandboxRenderUrl()}
          title={published.title}
          className="atrium-artifact-viewport"
        />
      </div>
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
  // embed is gated STRICTLY on the artifact's own `visibility_level === 'public'`
  // (public audience, no session) — a non-public embed renders a quiet placeholder,
  // never its content, so the public page never leaks non-public artifacts.
  const parts = await resolveDocumentParts(markdown, { audience: "public" });

  // "ON THIS PAGE" TOC — built server-side from the document's own headings (no
  // session read); empty when the body is empty.
  const headings = extractDocumentHeadings(markdown);

  return (
    <ReaderFrame
      title={published.title}
      authenticated={false}
      editHref={null}
      commentHref={null}
      commentCount={0}
      publishedAt={published.publishedAt}
      collectionName={published.collectionName}
      headings={headings}
      // Anonymous surface: drops the "<Org> Intranet" nav and the view-only
      // explainer, keeps the reading sheet and the provenance footer.
      surface="public"
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
