/**
 * Atrium public reader page (RSC, anonymous)
 *
 * Issue #1057 (Epic #1059, Atrium Phase 7, spec §20 / §26.4). The world-readable
 * twin of the internal `/c/[slug]` reader. It resolves a slug, confirms a *live*
 * `public_web` publication, enforces `visibility_level = 'public'`, then renders
 * the SAME sanitized markdown (`source.md`) or the SAME cross-origin artifact
 * sandbox as the internal reader, plus a provenance footer.
 *
 * ## Anonymous by design — public means public, for EVERYONE
 * This route is in `PUBLIC_PATHS` (middleware) so no session is required. Unlike
 * the internal reader — which uses `canView(session-principal)` and can therefore
 * surface `group`/`internal` content to an in-audience viewer — the PUBLIC reader
 * gates STRICTLY on `visibility_level === 'public'` and does NOT consult any
 * session. Rationale: `/p/[slug]` is a public surface; it must serve the SAME
 * thing to an anonymous visitor and to a logged-in staff member. Gating on
 * `canView(session)` here would leak non-public content to authenticated users
 * through the public URL (e.g. an `internal` object that was published to
 * `public_web` while its visibility stayed `internal`). `visibility_level ===
 * 'public'` is exactly the world-readable predicate (`canView` short-circuits to
 * `true` for `public` regardless of principal), so the strict check is both
 * simpler and strictly safer than a guest `canView`.
 *
 * ## Visibility gate (always 404, never 403)
 * No object for the slug, no live `public_web` publication, OR a non-`public`
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
 * `public_web` publication that authorized it).
 */

import { cache } from "react";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { executeQuery } from "@/lib/db/drizzle-client";
import { contentObjects, contentPublications } from "@/lib/db/schema";
import { renderMarkdownToHtml } from "@/lib/content/render/markdown-render";
import { s3Store } from "@/lib/content/storage/s3-store";
import { versionService } from "@/lib/content/version-service";
import { createLogger } from "@/lib/logger";
import { ProvenanceFooter } from "@/components/atrium/ProvenanceFooter";
import { ArtifactSandbox } from "@/components/atrium/ArtifactSandbox";
import { getArtifactSandboxRenderUrl } from "@/lib/content/artifact-sandbox-config";
import "@/styles/atrium-content.css";
import "katex/dist/katex.min.css";

/**
 * The live publication + version are read per request; a cached page must never
 * outlive the `public_web` publication (an unpublish must 404 immediately).
 */
export const dynamic = "force-dynamic";

interface PublicReaderPageProps {
  // Next 15+/16 App Router: dynamic route params are a Promise.
  params: Promise<{ slug: string }>;
}

/**
 * Load the object + live `public_web` publication for a slug, but ONLY when the
 * object's visibility is `public`. Returns `null` otherwise (absent slug, no live
 * public_web publication, or a non-public object) — the single "may this be shown
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
  publishedVersionId: string;
} | null> => {
  const [obj] = await executeQuery(
    (db) =>
      db
        .select({
          id: contentObjects.id,
          kind: contentObjects.kind,
          title: contentObjects.title,
          visibilityLevel: contentObjects.visibilityLevel,
        })
        .from(contentObjects)
        .where(eq(contentObjects.slug, slug))
        .limit(1),
    "atrium.publicReader.objectBySlug"
  );
  if (!obj) return null;

  // STRICT public gate: the public route serves ONLY world-readable content.
  // A non-public object (even one published to public_web while its visibility
  // stayed internal/group) is treated as absent — 404, never 403.
  if (obj.visibilityLevel !== "public") return null;

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
            eq(contentPublications.destination, "public_web"),
            eq(contentPublications.status, "live")
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
    publishedVersionId: publication.publishedVersionId,
  };
});

/**
 * Page metadata. The title is resolved ONLY for an object that passes the public
 * gate (public visibility + a live public_web publication) — its title is
 * world-readable by definition, so exposing it in the tab/link preview leaks
 * nothing. Anything that fails the gate gets a generic title, so a probe cannot
 * distinguish a private slug from an absent one via metadata either.
 */
export async function generateMetadata({
  params,
}: PublicReaderPageProps): Promise<Metadata> {
  const { slug } = await params;
  const published = await loadPublicObject(slug);
  return { title: published ? published.title : "Atrium" };
}

/**
 * The public reader. See the file header for the full anonymous/404 decision tree.
 */
export default async function PublicReaderPage({
  params,
}: PublicReaderPageProps): Promise<React.JSX.Element> {
  const { slug } = await params;
  const log = createLogger({ action: "atrium.publicReaderPage" });

  // Object must exist, be `public`, AND have a live public_web publication, else
  // 404. No session is consulted — the gate is entirely visibility-based.
  const published = await loadPublicObject(slug);
  if (!published) {
    notFound();
  }

  // Load the published version (object-scoped) for its body.
  const version = await versionService.getById(
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
    let code = "";
    try {
      code = await versionService.loadArtifactCode(version);
    } catch (error) {
      // Missing/unreadable artifact body degrades to an empty preview rather than
      // surfacing the raw S3 error to the reader.
      log.warn("artifact body unavailable; rendering empty preview", {
        objectId: version.objectId,
        versionNumber: version.versionNumber,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return (
      <main className="mx-auto max-w-4xl px-4 py-8">
        <header className="mb-6">
          <h1 className="text-3xl font-semibold">{published.title}</h1>
        </header>
        <ArtifactSandbox
          code={code}
          src={getArtifactSandboxRenderUrl()}
          className="atrium-artifact-preview"
        />
        <ProvenanceFooter
          objectId={published.id}
          publishedVersionId={published.publishedVersionId}
        />
      </main>
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
      <ProvenanceFooter
          objectId={published.id}
          publishedVersionId={published.publishedVersionId}
        />
    </main>
  );
}
