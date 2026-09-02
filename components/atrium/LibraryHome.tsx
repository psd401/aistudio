"use client";

/**
 * Atrium library HOME — the curated default view.
 *
 * ## Why this exists
 *
 * The library used to open on "All content": one flat grid, newest-first, of
 * every object the viewer could see. For an administrator that is the entire
 * district's content at once — `buildVisibilitySql` short-circuits to `true` for
 * an admin — so the first thing the person with the most context saw was the
 * least navigable thing in the product, with everything already filed into
 * sections dumped alongside everything that was not.
 *
 * Home instead leads with the small, personal, and structural:
 *
 *   1. FAVORITES   — what this person deliberately kept (shown only if any).
 *   2. UNFILED     — their own work not yet put away: the real to-do list.
 *   3. YOUR RECENT — what they touched last, not what the district touched last.
 *   4. SECTIONS    — the intranet's actual structure, as browsable cards.
 *
 * Bands 2 and 3 are disjoint by construction (`unfiled` vs `filed`). They were
 * both plain `owner: "mine"` at first, which rendered every unfiled document
 * twice on one screen.
 *
 * "All content" is still one click away; it is a destination now, not the door.
 *
 * ## Band loading
 *
 * Each band issues its own bounded `listContentAction`. They are independent on
 * purpose: a band that fails or is empty collapses without taking the page with
 * it. Bands render STATIC cards only — `ArtifactThumbnail` shares a module-level
 * cap of live sandbox iframes across the whole page, so letting several bands
 * mount live previews would starve whichever band drew last and leave it stuck
 * on gradients for no benefit at this size.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Loader2,
  Star,
  Clock,
  FolderOpen,
  Inbox,
  ArrowRight,
  Activity,
} from "lucide-react";
import { listContentAction } from "@/actions/db/atrium/list-content";
import { recentSince, WHATS_NEW_DAYS } from "@/lib/atrium/recent-window";
import { collectionTreeAction } from "@/actions/db/atrium/collection-tree";
import type { ContentObjectDTO, ListFilter } from "@/lib/content";
import type { CollectionTreeNode } from "@/lib/content/collection-service";
import { createLogger } from "@/lib/client-logger";
import { ContentCard } from "./LibraryList";

const log = createLogger({ component: "LibraryHome" });

/** How many cards a band shows before deferring to its "See all" link. */
const BAND_SIZE = 6;

/**
 * How many section cards the home shows. The tree is not bounded by anything —
 * a district accumulates sections, and every private collection anyone owns is
 * in their own tree — so rendering all of them turned the "Sections" band into
 * the same undifferentiated wall the home page exists to replace. The sidebar
 * remains the complete, browsable tree.
 */
const SECTION_BAND_SIZE = 8;

/**
 * One bounded band fetch. Deliberately NOT `useLibraryPage`: that hook owns
 * pagination, selection, and a single active filter for the main grid, none of
 * which a fixed-size band needs.
 *
 * The `seq` guard makes the LAST issued request the only one allowed to write —
 * bands re-fetch when the page signals a change, and an earlier slow response
 * must not overwrite a newer one.
 */
function useBand(filter: ListFilter, reloadKey: number): {
  items: ContentObjectDTO[];
  loading: boolean;
} {
  const [items, setItems] = useState<ContentObjectDTO[]>([]);
  const [loading, setLoading] = useState(true);
  // Serialize the filter so the effect depends on its VALUE, not on the object
  // identity a parent re-render would change every time.
  const key = JSON.stringify(filter);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      try {
        const res = await listContentAction({
          ...(JSON.parse(key) as ListFilter),
          limit: BAND_SIZE,
        });
        if (cancelled) return;
        if (res.isSuccess) setItems(res.data);
        else {
          setItems([]);
          log.warn("band load failed", { key, message: res.message });
        }
      } catch (e) {
        if (!cancelled) {
          setItems([]);
          log.error("band load threw", {
            key,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [key, reloadKey]);

  return { items, loading };
}

/** A band heading with an optional "see all" affordance. */
function BandHead({
  icon,
  title,
  seeAllLabel,
  onSeeAll,
}: {
  icon: React.ReactNode;
  title: string;
  seeAllLabel?: string;
  onSeeAll?: () => void;
}): React.JSX.Element {
  return (
    <div className="mer-band-head">
      <h2 className="mer-band-title">
        <span className="mer-band-icon" aria-hidden="true">
          {icon}
        </span>
        {title}
      </h2>
      {seeAllLabel &&
        (onSeeAll ? (
          <button type="button" className="mer-band-more" onClick={onSeeAll}>
            {seeAllLabel}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : (
          // Some bands have no "see all" destination (Sections — the sidebar
          // tree already IS the complete list), but still need to say that the
          // band is a subset. A button that goes nowhere would be worse.
          <span className="mer-band-note">{seeAllLabel}</span>
        ))}
    </div>
  );
}

/** A band of content cards. Renders nothing at all when empty (see `hideEmpty`). */
function ContentBand({
  icon,
  title,
  filter,
  reloadKey,
  hideEmpty,
  emptyText,
  seeAllLabel,
  onSeeAll,
  onFavoriteChange,
  testId,
}: {
  icon: React.ReactNode;
  title: string;
  filter: ListFilter;
  reloadKey: number;
  /** Collapse the whole band when it has no items (Favorites, Unfiled). */
  hideEmpty: boolean;
  emptyText?: string;
  seeAllLabel?: string;
  onSeeAll?: () => void;
  onFavoriteChange?: (id: string, isFavorite: boolean) => void;
  testId: string;
}): React.JSX.Element | null {
  const { items, loading } = useBand(filter, reloadKey);

  // An empty optional band is worse than no band: it is a heading promising
  // content that is not there. Collapse it once the load has actually finished
  // (never mid-load, which would make bands flicker in and out).
  if (!loading && items.length === 0 && hideEmpty) return null;

  return (
    <section className="mer-band" data-testid={testId}>
      <BandHead
        icon={icon}
        title={title}
        seeAllLabel={seeAllLabel}
        onSeeAll={onSeeAll}
      />
      {loading ? (
        <div className="mer-band-loading" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…
        </div>
      ) : items.length === 0 ? (
        <p className="mer-band-empty">{emptyText}</p>
      ) : (
        <div className="mer-card-grid">
          {items.map((it) => (
            <ContentCard
              key={it.id}
              it={it}
              // Bands never mount live artifact frames — see the file header.
              sandboxSrc={null}
              onFavoriteChange={onFavoriteChange}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** The sections band: top-level collections as browsable cards. */
function SectionsBand(): React.JSX.Element | null {
  const [nodes, setNodes] = useState<CollectionTreeNode[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await collectionTreeAction();
        if (cancelled) return;
        if (res.isSuccess) setNodes(res.data);
        else log.warn("collectionTreeAction failed", { message: res.message });
      } catch (e) {
        if (!cancelled) {
          log.error("collectionTreeAction threw", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loading && nodes.length === 0) return null;

  // Lead with the sections that actually hold something, then by name. An empty
  // section is not hidden — a brand-new one must still be findable — it just
  // does not outrank a section full of pages for one of the few slots.
  const ranked = [...nodes].sort(
    (a, b) => subtreeCount(b) - subtreeCount(a) || a.name.localeCompare(b.name)
  );
  const shown = ranked.slice(0, SECTION_BAND_SIZE);
  const hidden = ranked.length - shown.length;

  return (
    <section className="mer-band" data-testid="home-band-sections">
      <BandHead
        icon={<FolderOpen className="h-4 w-4" />}
        title="Sections"
        // No "see all" target exists for sections — the sidebar tree IS the
        // complete list — so this states the remainder rather than linking.
        seeAllLabel={hidden > 0 ? `${hidden} more in the sidebar` : undefined}
      />
      {loading ? (
        <div className="mer-band-loading" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…
        </div>
      ) : (
        <div className="mer-section-grid">
          {shown.map((node) => (
            <Link
              key={node.id}
              href={`/atrium/s/${node.slug}`}
              className="mer-section-card"
              data-testid={`section-card-${node.slug}`}
            >
              <span className="mer-section-card-icon" aria-hidden="true">
                <FolderOpen className="h-4 w-4" />
              </span>
              <span className="mer-section-card-name">{node.name}</span>
              {node.description && (
                <span className="mer-section-card-desc">{node.description}</span>
              )}
              <span className="mer-section-card-meta">
                {subtreeCount(node)} item{subtreeCount(node) === 1 ? "" : "s"}
                {node.children.length > 0 &&
                  ` · ${node.children.length} subsection${node.children.length === 1 ? "" : "s"}`}
              </span>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

/** Visible objects in a section AND everything nested under it. */
function subtreeCount(node: CollectionTreeNode): number {
  return (
    node.visibleObjectCount +
    node.children.reduce((sum, child) => sum + subtreeCount(child), 0)
  );
}

export interface LibraryHomeProps {
  /** Switch the parent to a full-grid view (the bands' "see all" targets). */
  onSeeAll: (view: "all" | "mine" | "unfiled" | "favorites" | "recent") => void;
}

export function LibraryHome({ onSeeAll }: LibraryHomeProps): React.JSX.Element {
  // Unstarring inside the Favorites band must remove the card. Bumping this key
  // re-runs every band's fetch, which is cheap at BAND_SIZE and keeps the bands
  // consistent with each other (a star toggled in "Recent" updates "Favorites").
  const [reloadKey, setReloadKey] = useState(0);
  const handleFavoriteChange = useCallback(() => {
    setReloadKey((n) => n + 1);
  }, []);

  return (
    <div className="mer-home" data-testid="library-home">
      <ContentBand
        testId="home-band-favorites"
        icon={<Star className="h-4 w-4" />}
        title="Favorites"
        filter={{ favorite: true }}
        reloadKey={reloadKey}
        hideEmpty
        seeAllLabel="See all favorites"
        onSeeAll={() => onSeeAll("favorites")}
        onFavoriteChange={handleFavoriteChange}
      />
      <ContentBand
        testId="home-band-unfiled"
        icon={<Inbox className="h-4 w-4" />}
        title="Not in a section yet"
        // Disjoint from "Your recent work" below BY CONSTRUCTION (that band is
        // `filed`). Both bands used to be `owner: "mine"` with no filed filter,
        // so every unfiled document rendered twice on the same page — which
        // reads as a bug, not as two useful views.
        filter={{ filed: "unfiled", owner: "mine" }}
        reloadKey={reloadKey}
        hideEmpty
        seeAllLabel="See all unfiled"
        onSeeAll={() => onSeeAll("unfiled")}
        onFavoriteChange={handleFavoriteChange}
      />
      <ContentBand
        testId="home-band-recent"
        icon={<Clock className="h-4 w-4" />}
        title="Your recent work"
        filter={{ owner: "mine", filed: "filed" }}
        reloadKey={reloadKey}
        hideEmpty={false}
        emptyText="Nothing yet — create a doc or an interactive page to get started."
        seeAllLabel="See all yours"
        onSeeAll={() => onSeeAll("mine")}
        onFavoriteChange={handleFavoriteChange}
      />
      <ContentBand
        testId="home-band-whats-new"
        icon={<Activity className="h-4 w-4" />}
        title="New across the district"
        // The one band that is NOT personal: everything the viewer can see,
        // anyone's, filed or not, touched in the last WHATS_NEW_DAYS. Home led
        // only with "yours" before, so what the rest of the district was doing
        // was invisible until you went looking. Hour-stable `since` — see
        // recentSince.
        filter={{ since: recentSince(WHATS_NEW_DAYS) }}
        reloadKey={reloadKey}
        hideEmpty={false}
        emptyText={`Nothing has changed in the last ${WHATS_NEW_DAYS} days.`}
        seeAllLabel="See everything new"
        onSeeAll={() => onSeeAll("recent")}
        onFavoriteChange={handleFavoriteChange}
      />
      <SectionsBand />
    </div>
  );
}

export default LibraryHome;
