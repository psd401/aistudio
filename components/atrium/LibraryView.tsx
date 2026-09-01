"use client";

/**
 * Atrium LibraryView — the permission-filtered content library (spec §21),
 * restyled to the Meridian card grid (Epic #1059 redesign, slice B).
 *
 * The library lists exactly the content the requester may view (the list action
 * is permission-pushed via `canView`), with a debounced SERVER-side search over
 * titles and tags (#1336 — previously a client-side title-only filter over the
 * already-loaded page, which silently missed everything on page 2+), filter
 * chips (All / Docs / Artifacts / Shared with me — the last driven by the
 * server-side `owner: "shared"` filter), a debounced exact tag filter,
 * multi-select bulk actions (#1336), and "New doc" / "New artifact" creation.
 *
 * The section tree lives in the Meridian shell's workspace nav column
 * (`atrium/layout.tsx`); this view reads the shell's `?collection=` selection
 * reactively. Authorization is entirely server-side — this component renders only
 * what the actions return.
 *
 * Pagination (Epic #1059 completion): the list is fetched in 50-row pages
 * (limit/offset through `listContentAction`) with a "Load more" append control;
 * any server-side filter change resets to page one.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, Plus, Sparkles, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { listContentAction } from "@/actions/db/atrium/list-content";
import { listContentTagsAction } from "@/actions/db/atrium/list-tags";
import { createContentAction } from "@/actions/db/atrium/create-content";
import type { ContentObjectDTO, ContentKind, ListFilter } from "@/lib/content";
import { ARTIFACT_STARTER_HTML } from "@/lib/content/artifact-starter";
import { recentSince, WHATS_NEW_DAYS } from "@/lib/atrium/recent-window";
import { createLogger } from "@/lib/client-logger";
import { LibraryList } from "./LibraryList";
import { LibraryHome } from "./LibraryHome";
import { LibraryBulkBar } from "./LibraryBulkBar";
import { CreateContentDialog } from "./CreateContentDialog";
import { PrivateCollectionsDialog } from "./PrivateCollectionsDialog";

const log = createLogger({ component: "LibraryView" });

/**
 * The library filter chips. "shared" maps to the server `owner: "shared"`
 * ownership filter (content shared with the caller, not owned by them);
 * "archived" maps to the server `status: "archived"` filter (the ONLY view that
 * surfaces archived content — every other view excludes it, matching the default
 * list behavior in `visibilityService.listVisible`); the remaining chips map to
 * the `kind` filter (or no kind for "all"). The chips are single-select, so
 * "Archived" is a distinct lifecycle view showing all archived docs + artifacts.
 */
const VIEWS = [
  { value: "home", label: "Home" },
  { value: "all", label: "All content" },
  // District-wide, everything the viewer can see that was TOUCHED in the last
  // WHATS_NEW_DAYS (server `since` on updated_at) — the answer to "what has
  // changed around here lately", which "Your recent work" on Home is not.
  { value: "recent", label: "What's new" },
  { value: "favorites", label: "Favorites" },
  { value: "document", label: "Docs" },
  { value: "artifact", label: "Artifacts" },
  { value: "unfiled", label: "Unfiled" },
  { value: "archived", label: "Archived" },
] as const;

/**
 * The chips shown by DEFAULT. The full `VIEWS` list is every reachable view, but
 * putting all of them in the bar turned the filter row into a wall of options —
 * the same "everything at once" problem the home page exists to fix. The rest
 * stay reachable from the home bands' "see all" links, and a chip for the active
 * view is added back in `LibraryChips` so the bar always shows where you are.
 *
 * Ownership is deliberately NOT here — see `OWNER_FILTERS`.
 */
const PRIMARY_VIEWS: readonly LibraryFilterView[] = [
  "home",
  "all",
  "recent",
  "favorites",
  "document",
  "artifact",
  "archived",
];

/**
 * Ownership filter, applied ORTHOGONALLY to the view chips.
 *
 * These began life as chips, which was wrong: chips are single-select, so
 * picking "Mine" meant giving up "Docs", and "show me MY docs" — the single
 * most common question an administrator asks of a district-wide library — was
 * the one combination the bar could not express. Same mistake, and same fix, as
 * status and creator below.
 *
 * "Everyone else" is broader than "Shared with me" and they are not
 * complements: shared additionally requires group/private visibility, so
 * "others" is a superset of it.
 */
const OWNER_FILTERS = [
  { value: "any", label: "Anyone" },
  { value: "mine", label: "Mine" },
  { value: "others", label: "Everyone else" },
  { value: "shared", label: "Shared with me" },
] as const;

type LibraryOwnerFilter = (typeof OWNER_FILTERS)[number]["value"];

/**
 * Lifecycle filter, applied ORTHOGONALLY to the view chips.
 *
 * Not a chip: chips are single-select, so a "Published" chip would mean giving
 * up "Docs" to ask "which docs are published?" — which is the actual question,
 * and the one the chip row could never answer. "Archived" stays a view chip
 * rather than joining this control because it is a lifecycle DESTINATION (with
 * its own restore/delete affordances and its own empty state), not a lens on
 * the working set.
 */
const STATUS_FILTERS = [
  { value: "any", label: "Any status" },
  { value: "published", label: "Published" },
  { value: "draft", label: "Draft" },
] as const;

type LibraryStatusFilter = (typeof STATUS_FILTERS)[number]["value"];

/**
 * Creator filter (`content_objects.created_by_actor`), also orthogonal.
 *
 * Object-grain, matching the card badge: an agent-created doc later edited by a
 * human still reads as agent-created. Per-version authorship is a different
 * question and lives in the provenance footer.
 */
const ACTOR_FILTERS = [
  { value: "any", label: "Anyone" },
  { value: "human", label: "People" },
  { value: "agent", label: "Agents" },
] as const;

type LibraryActorFilter = (typeof ACTOR_FILTERS)[number]["value"];

type LibraryFilterView = (typeof VIEWS)[number]["value"];

/**
 * Server page size for the library list (Epic #1059 completion). Matches the
 * service default; "Load more" appends the next offset page.
 */
const PAGE_SIZE = 50;

/**
 * Derive a short, editable artifact title from the agent prompt (README: "Title
 * auto-suggested, editable inline"). First non-empty line, trimmed to a sane
 * length; falls back to a neutral placeholder the user can rename.
 */
function deriveArtifactTitle(promptText: string): string {
  const firstLine = promptText
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return "Untitled artifact";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77).trimEnd()}…` : firstLine;
}

/**
 * The Meridian creation flow (README Interactions), extracted from `LibraryView`
 * so its body stays under the max-lines lint:
 *  - `handleNewDoc` creates an untitled document and navigates straight to the
 *    editor (a blank sheet, no modal — the title is editable inline there).
 *  - `handleAgentCreate` creates the artifact, then deep-links into the Nexus
 *    workspace with the prompt prefilled (`?draft=`) so the agent builds it
 *    beside its live preview; returns an error string for the dialog, or null.
 */
function useLibraryCreate(collectionId: string | null) {
  const router = useRouter();
  const [agentPromptOpen, setAgentPromptOpen] = useState(false);
  const [creatingDoc, setCreatingDoc] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const handleNewDoc = useCallback(async () => {
    if (creatingDoc) return;
    setCreatingDoc(true);
    setCreateError(null);
    try {
      const res = await createContentAction({
        kind: "document",
        title: "Untitled",
        collectionId: collectionId ?? undefined,
      });
      if (res.isSuccess) {
        router.push(`/atrium/${res.data.id}/edit`);
        return; // keep the button disabled through the navigation
      }
      setCreateError(res.message ?? "Could not create the document");
      log.warn("createContentAction (doc) failed", { message: res.message });
    } catch (e) {
      setCreateError("Could not create the document");
      log.error("createContentAction (doc) threw", {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    setCreatingDoc(false);
  }, [creatingDoc, collectionId, router]);

  const handleAgentCreate = useCallback(
    async (promptText: string): Promise<string | null> => {
      // The starter body is what makes this artifact have a v1. Creating it
      // bodyless left `currentVersionId` null, and the authoring canvas has
      // nothing to load — the card in this very grid would open on an error.
      // The agent replaces this wholesale on its first turn.
      const res = await createContentAction({
        kind: "artifact",
        title: deriveArtifactTitle(promptText),
        collectionId: collectionId ?? undefined,
        body: ARTIFACT_STARTER_HTML,
        bodyFormat: "html",
      });
      if (res.isSuccess) {
        router.push(
          `/nexus?workspace=${res.data.id}&draft=${encodeURIComponent(promptText)}`
        );
        return null;
      }
      log.warn("createContentAction (artifact) failed", { message: res.message });
      return res.message ?? "Could not create the artifact";
    },
    [collectionId, router]
  );

  /**
   * Create an EMPTY interactive page and go straight to its editor — the
   * counterpart to "New doc". Before this, the only way to make one was to
   * describe it to the agent, which navigated out of Atrium into the Nexus chat
   * with no explanation. The starter body is what gives it a v1 (see
   * ARTIFACT_STARTER_HTML) so the editor never opens on an error.
   */
  const handleBlankArtifact = useCallback(async () => {
    const res = await createContentAction({
      kind: "artifact",
      title: "Untitled page",
      collectionId: collectionId ?? undefined,
      body: ARTIFACT_STARTER_HTML,
      bodyFormat: "html",
    });
    if (res.isSuccess) {
      router.push(`/atrium/${res.data.id}/edit`);
      return;
    }
    setCreateError(res.message ?? "Could not create the page");
    log.warn("createContentAction (blank artifact) failed", {
      message: res.message,
    });
  }, [collectionId, router]);

  return {
    agentPromptOpen,
    setAgentPromptOpen,
    creatingDoc,
    createError,
    handleNewDoc,
    handleAgentCreate,
    handleBlankArtifact,
  };
}

/**
 * The library header: title, ⌘K-focusable search, and the create buttons.
 * Presentational — all state lives in the parent.
 */
function LibraryHeader({
  search,
  onSearch,
  searchRef,
  onNewArtifact,
  onNewDoc,
  creatingDoc,
}: {
  search: string;
  onSearch: (v: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onNewArtifact: () => void;
  onNewDoc: () => void;
  /** A blank-doc create is in flight — disables the "New doc" button. */
  creatingDoc: boolean;
}): React.JSX.Element {
  return (
    <header className="mer-lib-header">
      <h1 className="mer-lib-title">Content library</h1>
      <div className="mer-search">
        <Search className="mer-search-icon h-4 w-4" aria-hidden="true" />
        <input
          ref={searchRef}
          type="text"
          aria-label="Search content by title or tag"
          placeholder="Search titles and tags…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          maxLength={200}
          className="mer-search-input"
        />
        <kbd className="mer-search-kbd" aria-hidden="true">
          ⌘K
        </kbd>
      </div>
      <PrivateCollectionsDialog />
      <button type="button" className="mer-btn" onClick={onNewArtifact}>
        <Sparkles className="h-4 w-4" aria-hidden="true" />
        New page
      </button>
      <button
        type="button"
        className="mer-btn mer-btn-primary"
        onClick={onNewDoc}
        disabled={creatingDoc}
      >
        {creatingDoc ? (
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        ) : (
          <Plus className="h-4 w-4" aria-hidden="true" />
        )}
        New doc
      </button>
    </header>
  );
}

/**
 * Tag suggestions for the tag box's typeahead.
 *
 * Server-backed rather than derived from the loaded page: the grid holds only
 * the current 50-row page, so a client-side distinct would suggest whichever
 * tags happen to be on screen and silently omit the rest. The action applies
 * the same visibility predicates as the listing, so a suggestion can never
 * reveal a tag from content the caller cannot see.
 *
 * Failures are swallowed to an empty list on purpose — the typeahead is an
 * accelerator, and the tag box stays fully usable by typing.
 */
function useTagSuggestions(prefix: string): string[] {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const reqSeqRef = useRef(0);

  useEffect(() => {
    const reqSeq = ++reqSeqRef.current;
    let cancelled = false;
    void (async () => {
      // Nothing typed yet → no request. The alternative (fetch the first page
      // of tags on mount so the box has something to show on focus) would put
      // a query on EVERY library load to serve a control most visits never
      // touch. One typed character is signal enough, and it is also the point
      // at which the suggestions get specific enough to be worth reading.
      //
      // Inside the IIFE, not synchronously in the effect body: a synchronous
      // setState in an effect triggers a cascading render (and the lint that
      // guards against it).
      if (prefix.trim().length === 0) {
        if (!cancelled && reqSeq === reqSeqRef.current) setSuggestions([]);
        return;
      }
      try {
        const res = await listContentTagsAction({ prefix });
        // Both guards: `cancelled` covers unmount, the sequence check covers a
        // slow earlier response landing after a newer one (last-request-wins).
        if (cancelled || reqSeq !== reqSeqRef.current) return;
        setSuggestions(res.isSuccess ? res.data : []);
      } catch {
        if (cancelled || reqSeq !== reqSeqRef.current) return;
        setSuggestions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prefix]);

  return suggestions;
}

/**
 * The filter chip row: view chips, the orthogonal status/creator selects, a
 * debounced tag filter with typeahead, and a "sorted by recent" affordance.
 * Presentational — all state lives in the parent.
 */
function LibraryChips({
  view,
  onView,
  tag,
  onTag,
  tagSuggestions,
  owner,
  onOwner,
  status,
  onStatus,
  actor,
  onActor,
  statusDisabled,
}: {
  view: LibraryFilterView;
  onView: (v: LibraryFilterView) => void;
  tag: string;
  onTag: (v: string) => void;
  tagSuggestions: string[];
  owner: LibraryOwnerFilter;
  onOwner: (v: LibraryOwnerFilter) => void;
  status: LibraryStatusFilter;
  onStatus: (v: LibraryStatusFilter) => void;
  actor: LibraryActorFilter;
  onActor: (v: LibraryActorFilter) => void;
  statusDisabled: boolean;
}): React.JSX.Element {
  return (
    <div className="mer-chip-row">
      <div className="mer-chips" role="group" aria-label="Filter content">
        {VIEWS.filter(
          (v) => PRIMARY_VIEWS.includes(v.value) || v.value === view
        ).map((v) => (
          <button
            key={v.value}
            type="button"
            className="mer-chip"
            data-active={view === v.value ? "true" : "false"}
            aria-pressed={view === v.value}
            onClick={() => onView(v.value)}
          >
            {v.label}
          </button>
        ))}
      </div>
      <div className="mer-chip-row-end">
        {/*
          Native selects, not the Radix `Select`: these sit in a dense toolbar
          beside a text input, and the portal-based popover version fights the
          chip row's overflow scrolling on narrow screens. Two fixed, tiny
          option lists need no combobox.
        */}
        <select
          aria-label="Filter by owner"
          className="mer-chip-select"
          value={owner}
          onChange={(e) => onOwner(e.target.value as LibraryOwnerFilter)}
          data-testid="library-owner-filter"
        >
          {OWNER_FILTERS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by status"
          className="mer-chip-select"
          value={statusDisabled ? "any" : status}
          disabled={statusDisabled}
          // The Archived view IS a status filter, so offering a second one
          // would let the user ask for "archived AND published" — an empty set
          // by construction, indistinguishable from a broken filter.
          title={
            statusDisabled
              ? "The Archived view already filters by status"
              : undefined
          }
          onChange={(e) => onStatus(e.target.value as LibraryStatusFilter)}
          data-testid="library-status-filter"
        >
          {STATUS_FILTERS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by creator"
          className="mer-chip-select"
          value={actor}
          onChange={(e) => onActor(e.target.value as LibraryActorFilter)}
          data-testid="library-actor-filter"
        >
          {ACTOR_FILTERS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
        <Input
          aria-label="Filter by tag"
          placeholder="Tag…"
          value={tag}
          onChange={(e) => onTag(e.target.value)}
          maxLength={100}
          className="h-9 w-28"
          // A native datalist rather than a custom popover: it is keyboard- and
          // screen-reader-accessible for free, and it does not capture typing —
          // the filter still applies as a prefix while you type, so a tag that
          // is not in the suggestion list is never unreachable.
          list="atrium-tag-suggestions"
          data-testid="library-tag-filter"
        />
        <datalist id="atrium-tag-suggestions">
          {tagSuggestions.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <span className="mer-sorted-label" data-testid="library-sort-label">
          {view === "recent"
            ? `Updated in the last ${WHATS_NEW_DAYS} days · newest first`
            : "Sorted by recent"}
        </span>
      </div>
    </div>
  );
}

/**
 * Map the active filter chip onto the server-side `ListFilter` fields. The
 * "Archived" chip is the ONLY view that requests archived content; every other
 * view leaves `status` undefined and the service then excludes archived rows
 * (default list behavior preserved). Pure — extracted so `LibraryView` stays
 * under the cyclomatic-complexity lint.
 */
function viewToFilter(view: LibraryFilterView): {
  kind?: ContentKind;
  status?: "archived";
  filed?: "unfiled";
  favorite?: true;
  since?: string;
} {
  switch (view) {
    case "document":
      return { kind: "document" };
    case "artifact":
      return { kind: "artifact" };
    case "favorites":
      return { favorite: true };
    case "unfiled":
      return { filed: "unfiled" };
    case "archived":
      return { status: "archived" };
    // Hour-stable (see recentSince): a per-render timestamp here would change
    // the serialized filter key every render and refetch forever.
    case "recent":
      return { since: recentSince(WHATS_NEW_DAYS) };
    // "home" never reaches the grid (LibraryHome renders instead), and "all"
    // applies no restriction.
    default:
      return {};
  }
}

/**
 * The section scope to send with the active view. "Unfiled" means "in no
 * section", so a section scope (the legacy `?collection=` deep link, where the
 * Home chip and its "See all unfiled" stay reachable) would AND
 * `collection_id = X` with `collection_id IS NULL`: an empty grid by
 * construction, rendered as the generic empty library and indistinguishable
 * from a broken filter. Same shape of rule as Archived-vs-status.
 */
function scopedCollectionId(
  collectionId: string | null,
  filed: "unfiled" | undefined
): string | undefined {
  if (filed === "unfiled") return undefined;
  return collectionId ?? undefined;
}

/**
 * Filters changed (or first mount): reload page one and drop the selection.
 * `fetchPage`'s identity changes exactly when a server filter changes, so it is
 * the correct trigger for both. A hook so `LibraryView` stays under the
 * max-lines lint.
 */
function useFilterChangeReset(
  fetchPage: (offset: number) => Promise<void>,
  clearSelection: () => void
): void {
  useEffect(() => {
    clearSelection();
    void fetchPage(0);
  }, [fetchPage, clearSelection]);
}

/**
 * Unstarring INSIDE the Favorites view: the card no longer matches the grid's
 * own filter, so it leaves at once (the home band does the same via a refetch).
 * Any other view keeps the card — a star is not a filter there. A hook so the
 * branch does not count against `LibraryView`'s complexity budget.
 */
function useFavoriteViewPrune(
  favoriteView: boolean,
  removeItem: (id: string) => void
): (id: string, isFavorite: boolean) => void {
  return useCallback(
    (id: string, isFavorite: boolean) => {
      if (favoriteView && !isFavorite) removeItem(id);
    },
    [favoriteView, removeItem]
  );
}

/**
 * The "Load more" control. Renders nothing once a short page signals the end,
 * while the first page loads, on a PAGE-ONE error, or when the current filter
 * matched nothing (a zero-result search must not render a dangling "Load more"
 * — #1336). A failed APPEND is different: the pages already on screen stay,
 * and the button stays with them so the append can simply be retried. Its own
 * component so those conditions do not count against `LibraryView`'s
 * complexity budget.
 */
function LoadMore({
  hasMore,
  loading,
  loadingMore,
  error,
  loadMoreError,
  itemCount,
  onLoadMore,
}: {
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMoreError: string | null;
  itemCount: number;
  onLoadMore: () => void;
}): React.JSX.Element | null {
  if (!hasMore || loading || error || itemCount === 0) return null;
  return (
    <div className="mt-5 flex flex-col items-center gap-2">
      {loadMoreError && (
        <p className="text-sm text-destructive" role="alert">
          {loadMoreError}
        </p>
      )}
      <button
        type="button"
        className={cn("mer-btn", loadingMore && "opacity-60")}
        disabled={loadingMore}
        onClick={onLoadMore}
      >
        {loadingMore ? "Loading…" : "Load more"}
      </button>
    </div>
  );
}

/**
 * Resolve the chip selection into everything the body needs: the view actually
 * in effect and its server filter.
 *
 * Home yields to a search: the bands are fixed, curated queries that ignore the
 * search and tag boxes, so leaving the viewer on Home while they type would make
 * those boxes look broken. Derived (not stored), so clearing the search returns
 * them to Home rather than stranding them in a grid they never chose.
 */
function resolveView(
  view: LibraryFilterView,
  searching: boolean
): {
  effectiveView: LibraryFilterView;
  kind?: ContentKind;
  status?: "archived";
  filed?: "unfiled";
  favorite?: true;
  since?: string;
  archivedView: boolean;
  homeView: boolean;
} {
  const effectiveView: LibraryFilterView =
    view === "home" && searching ? "all" : view;
  return {
    effectiveView,
    ...viewToFilter(effectiveView),
    archivedView: effectiveView === "archived",
    homeView: effectiveView === "home",
  };
}

/**
 * Debounce one free-text filter value. Both library free-text filters (search
 * and tag) are SERVER round-trips, so every keystroke must not reach
 * `listContentAction`.
 */
function useDebounced(value: string, delayMs = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

/**
 * ⌘K / Ctrl+K focuses the library search (the design's "⌘K" hint). Global
 * listener, cleaned up on unmount. No "is a text field already focused?" guard
 * is needed — ⌘/Ctrl+K is not a text-entry combo.
 */
function useSearchHotkey(ref: React.RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ref.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ref]);
}

/**
 * Every field the library grid can filter on. `limit`/`offset` are the hook's
 * own paging, so the type refuses them from a caller.
 */
type LibraryPageFilter = Omit<ListFilter, "limit" | "offset">;

/**
 * The library's paged fetch (extracted from `LibraryView` so its body stays
 * under the max-lines lint). `fetchPage(0)` REPLACES the list for the current
 * filters; a non-zero offset APPENDS (the "Load more" path). A monotonic
 * sequence ref drops stale responses so a slow earlier request cannot overwrite
 * a newer one.
 */
function useLibraryPage(filter: LibraryPageFilter) {
  const [items, setItems] = useState<ContentObjectDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // Whether the LAST fetched page was full (== PAGE_SIZE rows): a short page
  // means the end was reached, so "Load more" hides.
  const [hasMore, setHasMore] = useState(false);
  // A page-one failure: `LibraryList` renders it INSTEAD of the grid.
  const [error, setError] = useState<string | null>(null);
  // A failed "Load more" is kept apart from `error` on purpose: it must not
  // take the pages already on screen down with it, and `LoadMore` keeps its
  // button so the append can be retried.
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  // The serialized filter the on-screen result (the items, or the page-one
  // error) was fetched with — undefined until the first fetch finishes, then
  // set in the same state batch as `setItems`/`setError` so it can never
  // describe a grid the view isn't showing. Rendered as `data-results-key`
  // (plus the older `data-results-query`/`-status` projections) on the library
  // section: the only deterministic "the grid now reflects THIS filter set"
  // signal — `loading` flips inside a post-paint effect, leaving a window where
  // the filters have changed but neither `loading` nor the items say so, and
  // the loading spinner unmounts every card, so "the other card is gone" alone
  // proves nothing. E2E waits on this instead of racing the debounce or a
  // chip's refetch.
  const [settledKey, setSettledKey] = useState<string | undefined>(undefined);
  const reqSeqRef = useRef(0);

  // Identity by VALUE. The caller builds a fresh literal every render, and a
  // hand-maintained field list here (destructure + payload + deps) is exactly
  // what silently dropped `filed`/`favorite`: three commits edited that list,
  // two of them missed the fields, and nothing could flag it — an
  // un-destructured field is never referenced, so neither the type system nor
  // exhaustive-deps sees it. Keying on the serialized filter forwards EVERY
  // field and rebuilds `fetchPage` iff a value changes, the same idiom
  // `useBand` uses in LibraryHome. Deterministic: one call site, fixed literal
  // key order, primitives only, `undefined` omitted.
  const filterKey = JSON.stringify(filter);

  const fetchPage = useCallback(
    async (offset: number) => {
      const reqSeq = ++reqSeqRef.current;
      const append = offset > 0;
      const fail = (message: string) => {
        if (append) setLoadMoreError(message);
        else setError(message);
      };
      if (append) {
        setLoadingMore(true);
        setLoadMoreError(null);
      } else {
        setLoading(true);
        setError(null);
      }
      try {
        const res = await listContentAction({
          ...(JSON.parse(filterKey) as LibraryPageFilter),
          limit: PAGE_SIZE,
          offset,
        });
        if (reqSeq !== reqSeqRef.current) return; // stale response — drop it
        if (res.isSuccess) {
          setItems((prev) => (append ? [...prev, ...res.data] : res.data));
          setHasMore(res.data.length === PAGE_SIZE);
        } else {
          fail(res.message ?? "Could not load content");
          log.warn("listContentAction failed", { message: res.message });
        }
        // Success OR failure: whatever is on screen now answers to this filter.
        setSettledKey(filterKey);
      } catch (e) {
        if (reqSeq !== reqSeqRef.current) return;
        fail("Could not load content");
        setSettledKey(filterKey);
        log.error("listContentAction threw", {
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        if (reqSeq === reqSeqRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [filterKey]
  );

  // A STABLE re-fetch handle that always runs the CURRENT `fetchPage`.
  //
  // `fetchPage`'s identity changes with the filters, so a consumer that captures
  // it at click time (e.g. `LibraryBulkBar.run()` holding `onRefresh` across a
  // multi-second fan-out) would, if the user changed a filter mid-flight, call
  // the OLD closure and refetch the STALE filter set. That late call still bumps
  // `reqSeqRef`, so it wins the "latest response wins" race and repopulates the
  // grid with results for a filter no longer shown anywhere in the UI.
  //
  // Routing through a ref assigned in the render body (never in an effect —
  // see CLAUDE.md's React patterns) keeps `refresh` referentially stable while
  // always resolving to the newest filters.
  const fetchPageRef = useRef(fetchPage);
  fetchPageRef.current = fetchPage;
  const refresh = useCallback(() => {
    void fetchPageRef.current(0);
  }, []);

  // Append the next offset page. `items.length` (not a page counter) is the
  // offset so a short final page can never skip rows.
  const loadMore = useCallback(() => {
    void fetchPage(items.length);
  }, [fetchPage, items.length]);

  // Drop one row locally — a card unstarred inside the Favorites view no longer
  // matches the grid's own filter. Cheaper and calmer than `refresh()`: no
  // spinner, no collapse of "Load more" pages, and `loadMore`'s `items.length`
  // offset stays right because the server's result set shrank by the same row.
  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  // The older per-field projections, derived from the key so they can never
  // disagree with it (search pinning in other specs awaits `data-results-query`).
  const settled =
    settledKey === undefined
      ? undefined
      : (JSON.parse(settledKey) as LibraryPageFilter);

  return {
    items,
    loading,
    loadingMore,
    hasMore,
    error,
    loadMoreError,
    settledKey,
    settledQuery: settled ? (settled.query ?? "") : undefined,
    settledStatus: settled ? (settled.status ?? "") : undefined,
    fetchPage,
    loadMore,
    refresh,
    removeItem,
  };
}

/**
 * A card dragged into (or out of) a section by `AtriumDndProvider` changes its
 * filing, so it must leave a section view / the Unfiled view: re-fetch page
 * one, exactly like a bulk move does through `refresh`. Its own hook so the
 * listener does not count against `LibraryView`'s max-lines budget.
 */
function useContentMovedRefresh(refresh: () => void): void {
  useEffect(() => {
    window.addEventListener("atrium:content-moved", refresh);
    return () => window.removeEventListener("atrium:content-moved", refresh);
  }, [refresh]);
}

/**
 * Multi-select state for the bulk-action bar (#1336). The caller clears it
 * whenever the underlying set changes (filter/search/section change or a
 * post-mutation refetch) so a bulk action can never operate on ids the user can
 * no longer see.
 */
function useLibrarySelection() {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const clearSelection = useCallback(() => setSelected(new Set()), []);
  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  // Subtractive deselect for post-bulk-action cleanup: removes exactly the ids
  // a completed action succeeded on, so picks made WHILE the fan-out was in
  // flight (and failed ids awaiting a retry) survive. A whole-set reset here
  // silently discarded them.
  const removeFromSelection = useCallback((ids: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);
  return { selected, clearSelection, toggleSelect, removeFromSelection };
}

/**
 * Translate a home band's "see all" target into filter state.
 *
 * "mine" is no longer a VIEW — ownership became an orthogonal select so it can
 * combine with Docs/Artifacts — so the band's intent is expressed as the pair
 * it always meant: the full grid, filtered to this person's content.
 *
 * "unfiled" carries the same ownership. Its band is "Not in a section yet" —
 * `{ filed: "unfiled", owner: "mine" }`, the caller's own to-do list — so
 * "See all" opens that same list in full, not every unfiled object in the
 * district (which, for an admin, is exactly the firehose the home page exists
 * to avoid). The owner select stays live, so widening is one click away.
 *
 * Extracted from `LibraryView` to keep it under the max-lines lint.
 */
function useSeeAllHandler(
  setView: (v: LibraryFilterView) => void,
  setOwnerFilter: (v: LibraryOwnerFilter) => void
): (target: "all" | "mine" | "unfiled" | "favorites" | "recent") => void {
  return useCallback(
    (target) => {
      if (target === "mine") {
        setView("all");
        setOwnerFilter("mine");
        return;
      }
      if (target === "unfiled") setOwnerFilter("mine");
      setView(target);
    },
    [setView, setOwnerFilter]
  );
}

export interface LibraryViewProps {
  /**
   * The cross-origin sandbox render URL, resolved SERVER-SIDE
   * (`getArtifactSandboxRenderUrl()`) and passed from the Atrium page. Threaded to
   * each artifact card's live thumbnail (slice F). `null` (unconfigured sandbox
   * origin) → cards keep the gradient placeholder.
   */
  sandboxSrc?: string | null;
}

export function LibraryView({
  sandboxSrc = null,
}: LibraryViewProps = {}): React.JSX.Element {
  const searchParams = useSearchParams();

  // Section selection is URL-driven (`?collection=<id>`): the Meridian shell's
  // workspace nav column owns the tree and pushes the selection into the URL, and
  // the reader's collection sidebar deep-links here the same way. `useSearchParams`
  // already re-renders on any URL change, so reading the param directly (no local
  // state + sync effect) is all that's needed for the shell tree to drive the grid.
  const collectionId = searchParams.get("collection");

  // Home is the default — but ONLY at /atrium. Arriving with ?collection= means
  // the viewer asked for one section's contents, and answering that with the
  // curated home would ignore the request. (Section links now target
  // /atrium/s/[slug]; this keeps older ?collection= deep links working.)
  const [view, setView] = useState<LibraryFilterView>(
    collectionId ? "all" : "home"
  );
  const [tag, setTag] = useState("");
  const [search, setSearch] = useState("");
  // Orthogonal to the view chips — see STATUS_FILTERS / ACTOR_FILTERS.
  const [ownerFilter, setOwnerFilter] = useState<LibraryOwnerFilter>("any");
  const [statusFilter, setStatusFilter] = useState<LibraryStatusFilter>("any");
  const [actorFilter, setActorFilter] = useState<LibraryActorFilter>("any");
  const searchRef = useRef<HTMLInputElement>(null);

  // BOTH free-text filters are SERVER round-trips (#1336 moved the title search
  // server-side and widened it to match tags, so it now finds rows on page 2+
  // that a client-side filter over the already-loaded page could never see).
  const debouncedTag = useDebounced(tag);
  const debouncedSearch = useDebounced(search);

  // Typing in the search or tag box must leave Home: the bands are fixed,
  // curated queries that ignore both, so staying on Home would make the search
  // box look broken. DERIVED rather than a setState-in-effect — the effect
  // version fired a cascading render on every debounce tick, and this also means
  // clearing the search returns the viewer to Home instead of stranding them in
  // a filtered grid they never chose.
  const searching =
    debouncedSearch.trim().length > 0 || debouncedTag.trim().length > 0;

  useSearchHotkey(searchRef);

  // The Meridian creation flow (New doc → blank sheet; New artifact / create card
  // → agent-prompt dialog). Extracted to a hook to keep this body under the lint.
  const {
    agentPromptOpen,
    setAgentPromptOpen,
    creatingDoc,
    createError,
    handleNewDoc,
    handleAgentCreate,
    handleBlankArtifact,
  } = useLibraryCreate(collectionId);

  // Derive the server filter from the active chip.
  const { effectiveView, kind, status, filed, favorite, since, archivedView, homeView } =
    resolveView(view, searching);

  // The Archived VIEW wins over the status SELECT: it is itself a status
  // filter, and the select is disabled while it is active, so there is exactly
  // one status in play at a time.
  const effectiveStatus = archivedView
    ? status
    : statusFilter === "any"
      ? undefined
      : statusFilter;

  const handleSeeAll = useSeeAllHandler(setView, setOwnerFilter);

  const tagSuggestions = useTagSuggestions(debouncedTag);

  const {
    items,
    loading,
    loadingMore,
    hasMore,
    error,
    loadMoreError,
    settledKey,
    settledQuery,
    settledStatus,
    fetchPage,
    loadMore,
    refresh,
    removeItem,
  } = useLibraryPage({
      collectionId: scopedCollectionId(collectionId, filed),
      kind,
      owner: ownerFilter === "any" ? undefined : ownerFilter,
      status: effectiveStatus,
      filed,
      favorite,
      since,
      actor: actorFilter === "any" ? undefined : actorFilter,
      tag: debouncedTag.trim() || undefined,
      // Prefix, not whole-tag: typing toward a tag must narrow progressively
      // instead of emptying the grid until the final character.
      tagMatch: "prefix",
      query: debouncedSearch.trim() || undefined,
    });

  const { selected, clearSelection, toggleSelect, removeFromSelection } = useLibrarySelection();

  useFilterChangeReset(fetchPage, clearSelection);

  const handleFavoriteChange = useFavoriteViewPrune(favorite === true, removeItem);

  useContentMovedRefresh(refresh);

  // `refresh` (re-fetch page one after a bulk mutation, so archived rows leave
  // the default views and moved rows leave a section view) comes from the hook
  // and is referentially STABLE — see the note there for why re-deriving it from
  // `fetchPage` here would reintroduce a stale-filter refetch.

  return (
    <div className="w-full px-5 py-6 md:px-8 md:py-8">
      {/* `data-results-*`: the filter set the on-screen result was fetched for
          (absent until the first fetch finishes) — see `useLibraryPage`. */}
      <section
        className="mx-auto min-w-0 max-w-6xl"
        data-results-query={settledQuery}
        data-results-status={settledStatus}
        data-results-key={settledKey}
      >
        <LibraryHeader
          search={search}
          onSearch={setSearch}
          searchRef={searchRef}
          onNewArtifact={() => setAgentPromptOpen(true)}
          onNewDoc={() => void handleNewDoc()}
          creatingDoc={creatingDoc}
        />

        {createError && (
          <p className="mb-3 text-sm text-destructive" role="alert">
            {createError}
          </p>
        )}

        <LibraryChips
          view={effectiveView}
          onView={setView}
          tag={tag}
          onTag={setTag}
          tagSuggestions={tagSuggestions}
          owner={ownerFilter}
          onOwner={setOwnerFilter}
          status={statusFilter}
          onStatus={setStatusFilter}
          actor={actorFilter}
          onActor={setActorFilter}
          statusDisabled={archivedView}
        />

        {homeView ? (
          <LibraryHome onSeeAll={handleSeeAll} />
        ) : (
          <>
        <LibraryBulkBar
          selectedIds={[...selected]}
          onClear={clearSelection}
          onActed={removeFromSelection}
          onRefresh={refresh}
          archivedView={archivedView}
        />

        <LibraryList
          items={items}
          loading={loading}
          error={error}
          onCreate={() => setAgentPromptOpen(true)}
          sandboxSrc={sandboxSrc}
          archivedView={archivedView}
          selected={selected}
          onToggleSelect={toggleSelect}
          onFavoriteChange={handleFavoriteChange}
          searchTerm={debouncedSearch}
          tagTerm={debouncedTag}
        />

        <LoadMore
          hasMore={hasMore}
          loading={loading}
          loadingMore={loadingMore}
          error={error}
          loadMoreError={loadMoreError}
          itemCount={items.length}
          onLoadMore={loadMore}
        />
          </>
        )}
      </section>

      <CreateContentDialog
        key={agentPromptOpen ? "open" : "closed"}
        open={agentPromptOpen}
        onClose={() => setAgentPromptOpen(false)}
        onSubmit={handleAgentCreate}
        onStartBlank={handleBlankArtifact}
      />
    </div>
  );
}
