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
import { createContentAction } from "@/actions/db/atrium/create-content";
import type { ContentObjectDTO, ContentKind, ListFilter } from "@/lib/content";
import { ARTIFACT_STARTER_HTML } from "@/lib/content/artifact-starter";
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
  { value: "favorites", label: "Favorites" },
  { value: "mine", label: "Mine" },
  { value: "document", label: "Docs" },
  { value: "artifact", label: "Artifacts" },
  { value: "shared", label: "Shared with me" },
  { value: "unfiled", label: "Unfiled" },
  { value: "archived", label: "Archived" },
] as const;

/**
 * The chips shown by DEFAULT. The full `VIEWS` list is every reachable view, but
 * putting all nine in the bar turned the filter row into a wall of options —
 * the same "everything at once" problem the home page exists to fix. The rest
 * stay reachable from the home bands' "see all" links, and a chip for the active
 * view is added back in `LibraryChips` so the bar always shows where you are.
 */
const PRIMARY_VIEWS: readonly LibraryFilterView[] = [
  "home",
  "all",
  "favorites",
  "document",
  "artifact",
  "shared",
  "archived",
];

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
 * The filter chip row: view chips + a debounced tag filter + a "sorted by
 * recent" affordance. Presentational — all state lives in the parent.
 */
function LibraryChips({
  view,
  onView,
  tag,
  onTag,
}: {
  view: LibraryFilterView;
  onView: (v: LibraryFilterView) => void;
  tag: string;
  onTag: (v: string) => void;
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
        <Input
          aria-label="Filter by tag"
          placeholder="Tag…"
          value={tag}
          onChange={(e) => onTag(e.target.value)}
          maxLength={100}
          className="h-9 w-28"
        />
        <span className="mer-sorted-label">Sorted by recent</span>
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
  owner?: "shared" | "mine";
  status?: "archived";
  filed?: "unfiled";
  favorite?: true;
} {
  switch (view) {
    case "document":
      return { kind: "document" };
    case "artifact":
      return { kind: "artifact" };
    case "shared":
      return { owner: "shared" };
    case "mine":
      return { owner: "mine" };
    case "favorites":
      return { favorite: true };
    case "unfiled":
      return { filed: "unfiled" };
    case "archived":
      return { status: "archived" };
    // "home" never reaches the grid (LibraryHome renders instead), and "all"
    // applies no restriction.
    default:
      return {};
  }
}

/**
 * The "Load more" control. Renders nothing once a short page signals the end,
 * while the first page loads, on error, or when the current filter matched
 * nothing (a zero-result search must not render a dangling "Load more" —
 * #1336). Its own component so those four conditions do not count against
 * `LibraryView`'s complexity budget.
 */
function LoadMore({
  hasMore,
  loading,
  loadingMore,
  error,
  itemCount,
  onLoadMore,
}: {
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  itemCount: number;
  onLoadMore: () => void;
}): React.JSX.Element | null {
  if (!hasMore || loading || error || itemCount === 0) return null;
  return (
    <div className="mt-5 flex justify-center">
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
  owner?: "shared" | "mine";
  status?: "archived";
  filed?: "unfiled";
  favorite?: true;
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
 * The library's paged fetch (extracted from `LibraryView` so its body stays
 * under the max-lines lint). `fetchPage(0)` REPLACES the list for the current
 * filters; a non-zero offset APPENDS (the "Load more" path). A monotonic
 * sequence ref drops stale responses so a slow earlier request cannot overwrite
 * a newer one.
 */
function useLibraryPage(filter: ListFilter) {
  const [items, setItems] = useState<ContentObjectDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // Whether the LAST fetched page was full (== PAGE_SIZE rows): a short page
  // means the end was reached, so "Load more" hides.
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The query/status the COMMITTED items were fetched with (undefined until the
  // first fetch commits), set in the same state batch as `setItems` (so they can
  // never describe a grid the view isn't showing). Rendered as `data-results-*`
  // on the library section: the only deterministic "the grid now reflects THIS
  // search + view" signal — `loading` flips inside a post-paint effect, leaving
  // a window where the filters have changed but neither `loading` nor the items
  // say so. E2E search pinning awaits these instead of racing the debounce.
  const [settledQuery, setSettledQuery] = useState<string | undefined>(undefined);
  const [settledStatus, setSettledStatus] = useState<string | undefined>(undefined);
  const reqSeqRef = useRef(0);

  const { collectionId, kind, owner, status, tag, query } = filter;

  const fetchPage = useCallback(
    async (offset: number) => {
      const reqSeq = ++reqSeqRef.current;
      const append = offset > 0;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const res = await listContentAction({
          collectionId,
          kind,
          owner,
          status,
          tag,
          query,
          limit: PAGE_SIZE,
          offset,
        });
        if (reqSeq !== reqSeqRef.current) return; // stale response — drop it
        if (res.isSuccess) {
          setItems((prev) => (append ? [...prev, ...res.data] : res.data));
          setHasMore(res.data.length === PAGE_SIZE);
          setSettledQuery(query ?? "");
          setSettledStatus(status ?? "");
        } else {
          setError(res.message ?? "Could not load content");
          log.warn("listContentAction failed", { message: res.message });
        }
      } catch (e) {
        if (reqSeq !== reqSeqRef.current) return;
        setError("Could not load content");
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
    [collectionId, kind, owner, status, tag, query]
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

  return {
    items,
    loading,
    loadingMore,
    hasMore,
    error,
    settledQuery,
    settledStatus,
    fetchPage,
    refresh,
  };
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

  // ⌘K / Ctrl+K focuses the library search (design "⌘K" hint). Global listener,
  // cleaned up on unmount; ignores the combo when a modifier-less field already
  // has focus is unnecessary — ⌘/Ctrl+K is not a text-entry combo.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
  const { effectiveView, kind, owner, status, filed, favorite, archivedView, homeView } =
    resolveView(view, searching);

  const {
    items,
    loading,
    loadingMore,
    hasMore,
    error,
    settledQuery,
    settledStatus,
    fetchPage,
    refresh,
  } = useLibraryPage({
      collectionId: collectionId ?? undefined,
      kind,
      owner,
      status,
      filed,
      favorite,
      tag: debouncedTag.trim() || undefined,
      query: debouncedSearch.trim() || undefined,
    });

  const { selected, clearSelection, toggleSelect, removeFromSelection } =
    useLibrarySelection();

  // Filters changed (or first mount): reload page one and drop the selection.
  // `fetchPage`'s identity changes exactly when a server filter changes, so it
  // is the correct trigger for both.
  useEffect(() => {
    clearSelection();
    void fetchPage(0);
  }, [fetchPage, clearSelection]);

  // Append the next offset page. `items.length` (not a page counter) is the
  // offset so a short final page can never skip rows.
  const loadMore = useCallback(() => {
    void fetchPage(items.length);
  }, [fetchPage, items.length]);

  // `refresh` (re-fetch page one after a bulk mutation, so archived rows leave
  // the default views and moved rows leave a section view) comes from the hook
  // and is referentially STABLE — see the note there for why re-deriving it from
  // `fetchPage` here would reintroduce a stale-filter refetch.

  return (
    <div className="w-full px-5 py-6 md:px-8 md:py-8">
      {/* `data-results-*`: which query/view the committed grid was fetched for
          (absent until the first fetch commits) — see the settled-state note in
          `useLibraryPage`. */}
      <section
        className="mx-auto min-w-0 max-w-6xl"
        data-results-query={settledQuery}
        data-results-status={settledStatus}
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

        <LibraryChips view={effectiveView} onView={setView} tag={tag} onTag={setTag} />

        {homeView ? (
          <LibraryHome onSeeAll={setView} />
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
          searchTerm={debouncedSearch}
          tagTerm={debouncedTag}
        />

        <LoadMore
          hasMore={hasMore}
          loading={loading}
          loadingMore={loadingMore}
          error={error}
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
