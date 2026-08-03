"use client";

/**
 * The section landing page body (`/atrium/s/[slug]`).
 *
 * Layout, top to bottom:
 *   1. BREADCRUMB — where this section sits, and the way back up. The trail
 *      comes from the requester-filtered tree, so it never names an ancestor the
 *      viewer cannot enter.
 *   2. HERO — the section name and its description. The description is the whole
 *      point: a section with a name alone tells a reader nothing about what
 *      belongs in it or why they are here.
 *   3. START HERE — the pinned landing object, if the section has one. This is
 *      the "how do I get to the first page" affordance: for a section like
 *      Standard Operating Procedures, the index page is what you want, and
 *      "sorted by recent" will not reliably put it first.
 *   4. SUBSECTIONS — child sections as cards, so the hierarchy is visible
 *      without the sidebar.
 *   5. CONTENTS — this section's own pages, with a toggle to include everything
 *      nested beneath it.
 *
 * DIRECT vs SUBTREE: the default is direct children only. Drilling down is what
 * makes a deep tree navigable, and a flattened subtree at the top of a large
 * section reproduces exactly the undifferentiated wall of cards this whole pass
 * exists to remove. The toggle is there because "just show me everything in
 * here" is a real need — it is a deliberate choice, not the default.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  ChevronRight,
  FolderOpen,
  Loader2,
  Lock,
  Pin,
  Layers,
} from "lucide-react";
import { listContentAction } from "@/actions/db/atrium/list-content";
import type { ContentObjectDTO } from "@/lib/content";
import type { CollectionTreeNode } from "@/lib/content/collection-service";
import { createLogger } from "@/lib/client-logger";
import { ContentCard } from "./LibraryList";
import { SectionSettingsDialog } from "./SectionSettingsDialog";
import { cn } from "@/lib/utils";

const log = createLogger({ component: "SectionLanding" });

/** Visible objects in a section AND everything nested under it. */
function subtreeCount(node: CollectionTreeNode): number {
  return (
    node.visibleObjectCount +
    node.children.reduce((sum, child) => sum + subtreeCount(child), 0)
  );
}

function Breadcrumb({
  trail,
  current,
}: {
  trail: CollectionTreeNode[];
  current: string;
}): React.JSX.Element {
  return (
    <nav className="mer-section-crumbs" aria-label="Breadcrumb">
      <Link href="/atrium" className="mer-section-crumb">
        Library
      </Link>
      {trail.map((node) => (
        <span key={node.id} className="contents">
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          <Link href={`/atrium/s/${node.slug}`} className="mer-section-crumb">
            {node.name}
          </Link>
        </span>
      ))}
      <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
      <span className="mer-section-crumb mer-section-crumb--current" aria-current="page">
        {current}
      </span>
    </nav>
  );
}

/** The section hero: identity, scale, and what the section is FOR. */
function SectionHero({ node }: { node: CollectionTreeNode }): React.JSX.Element {
  const total = subtreeCount(node);
  const isPrivate = node.scope === "private";
  return (
    <header className="mer-section-hero">
      <div className="mer-section-hero-head">
        <span className="mer-section-hero-icon" aria-hidden="true">
          {isPrivate ? <Lock className="h-5 w-5" /> : <FolderOpen className="h-5 w-5" />}
        </span>
        <div>
          <h1 className="mer-section-hero-title" data-testid="section-title">
            {node.name}
          </h1>
          <p className="mer-section-hero-meta">
            {isPrivate ? "Private to you" : "Shared section"} · {total} item
            {total === 1 ? "" : "s"}
            {node.children.length > 0 &&
              ` · ${node.children.length} subsection${node.children.length === 1 ? "" : "s"}`}
          </p>
        </div>
        {/* `selectableForCreate` == the caller may create in this section, which
            is exactly the audience the server-side carve-out lets edit these two
            fields (SECTION_EDITOR_FIELDS). */}
        {node.selectableForCreate && (
          <div className="mer-section-hero-actions">
            <SectionSettingsDialog
              collectionId={node.id}
              sectionName={node.name}
              initialDescription={node.description}
              initialLandingObjectId={node.landingObjectId}
            />
          </div>
        )}
      </div>
      {node.description ? (
        <p className="mer-section-hero-desc" data-testid="section-description">
          {node.description}
        </p>
      ) : (
        // Not an error state — most sections predate descriptions. Points at the
        // fix rather than leaving an unexplained gap.
        <p className="mer-section-hero-desc mer-section-hero-desc--empty">
          {node.selectableForCreate
            ? "No description yet — use “Edit this page” to say what belongs here."
            : "No description yet."}
        </p>
      )}
    </header>
  );
}

/** Child sections as cards, so the hierarchy is visible without the sidebar. */
function SubsectionsBand({ node }: { node: CollectionTreeNode }): React.JSX.Element | null {
  if (node.children.length === 0) return null;
  return (
    <section className="mer-band" data-testid="section-subsections">
      <div className="mer-band-head">
        <h2 className="mer-band-title">
          <span className="mer-band-icon" aria-hidden="true">
            <Layers className="h-4 w-4" />
          </span>
          Subsections
        </h2>
      </div>
      <div className="mer-section-grid">
        {node.children.map((child) => (
          <Link
            key={child.id}
            href={`/atrium/s/${child.slug}`}
            className="mer-section-card"
            data-testid={`subsection-card-${child.slug}`}
          >
            <span className="mer-section-card-icon" aria-hidden="true">
              {child.scope === "private" ? (
                <Lock className="h-4 w-4" />
              ) : (
                <FolderOpen className="h-4 w-4" />
              )}
            </span>
            <span className="mer-section-card-name">{child.name}</span>
            {child.description && (
              <span className="mer-section-card-desc">{child.description}</span>
            )}
            <span className="mer-section-card-meta">
              {subtreeCount(child)} item{subtreeCount(child) === 1 ? "" : "s"}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

export interface SectionLandingProps {
  node: CollectionTreeNode;
  breadcrumb: CollectionTreeNode[];
  subtreeIds: string[];
  sandboxSrc: string | null;
}

export function SectionLanding({
  node,
  breadcrumb,
  subtreeIds,
  sandboxSrc,
}: SectionLandingProps): React.JSX.Element {
  const [includeSubsections, setIncludeSubsections] = useState(false);
  const [items, setItems] = useState<ContentObjectDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Serialized so the effect keys on the VALUE of the id list, not the array
  // identity a re-render would change.
  const idsKey = subtreeIds.join(",");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await listContentAction(
          includeSubsections
            ? { collectionIds: idsKey.split(",").filter(Boolean), limit: 100 }
            : { collectionId: node.id, limit: 100 }
        );
        if (cancelled) return;
        if (res.isSuccess) setItems(res.data);
        else {
          setItems([]);
          setError(res.message ?? "Could not load this section");
          log.warn("section list failed", { id: node.id, message: res.message });
        }
      } catch (e) {
        if (!cancelled) {
          setItems([]);
          setError("Could not load this section");
          log.error("section list threw", {
            id: node.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [node.id, idsKey, includeSubsections]);

  const toggleSubsections = useCallback(() => {
    setIncludeSubsections((v) => !v);
  }, []);

  // The pinned "start here" page, resolved out of the ALREADY permission-filtered
  // list rather than fetched by id. That is the point: a pin at an object this
  // viewer cannot see resolves to nothing and the strip simply does not render,
  // so the pin can never surface content the visibility gate would have withheld.
  const pinned =
    node.landingObjectId != null
      ? (items.find((it) => it.id === node.landingObjectId) ?? null)
      : null;

  return (
    <div className="w-full px-5 py-6 md:px-8 md:py-8">
      <section className="mx-auto min-w-0 max-w-6xl" data-testid="section-landing">
        <Breadcrumb trail={breadcrumb} current={node.name} />

        <SectionHero node={node} />

        <SubsectionsBand node={node} />

        {pinned && (
          <section className="mer-band" data-testid="section-pinned">
            <div className="mer-band-head">
              <h2 className="mer-band-title">
                <span className="mer-band-icon" aria-hidden="true">
                  <Pin className="h-4 w-4" />
                </span>
                Start here
              </h2>
            </div>
            <div className="mer-card-grid">
              <ContentCard it={pinned} sandboxSrc={sandboxSrc} />
            </div>
          </section>
        )}

        <section className="mer-band" data-testid="section-contents">
          <div className="mer-band-head">
            <h2 className="mer-band-title">
              <span className="mer-band-icon" aria-hidden="true">
                <Pin className="h-4 w-4" />
              </span>
              {includeSubsections ? "Everything in here" : "Pages in this section"}
            </h2>
            {node.children.length > 0 && (
              <button
                type="button"
                className={cn("mer-band-more", includeSubsections && "mer-band-more--on")}
                onClick={toggleSubsections}
                aria-pressed={includeSubsections}
                data-testid="toggle-subsections"
              >
                {includeSubsections
                  ? "Show only this section"
                  : "Include subsections"}
              </button>
            )}
          </div>

          {loading ? (
            <div className="mer-band-loading" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{" "}
              Loading…
            </div>
          ) : error ? (
            <p className="py-4 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : items.length === 0 ? (
            <p className="mer-band-empty">
              Nothing here yet.
              {node.children.length > 0 && !includeSubsections
                ? " The pages may live in a subsection above."
                : ""}
            </p>
          ) : (
            <div className="mer-card-grid">
              {items
                // Already shown above in "Start here" — no need to show it twice.
                .filter((it) => it.id !== pinned?.id)
                .map((it) => (
                  <ContentCard key={it.id} it={it} sandboxSrc={sandboxSrc} />
                ))}
            </div>
          )}
        </section>
      </section>
    </div>
  );
}

export default SectionLanding;
