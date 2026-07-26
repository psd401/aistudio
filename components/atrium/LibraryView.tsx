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
import { createLogger } from "@/lib/client-logger";
import { LibraryList } from "./LibraryList";
import { LibraryBulkBar } from "./LibraryBulkBar";
import { CreateContentDialog } from "./CreateContentDialog";

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
  { value: "all", label: "All" },
  { value: "document", label: "Docs" },
  { value: "artifact", label: "Artifacts" },
  { value: "shared", label: "Shared with me" },
  { value: "archived", label: "Archived" },
] as const;

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
      const res = await createContentAction({
        kind: "artifact",
        title: deriveArtifactTitle(promptText),
        collectionId: collectionId ?? undefined,
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

  return {
    agentPromptOpen,
    setAgentPromptOpen,
    creatingDoc,
    createError,
    handleNewDoc,
    handleAgentCreate,
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
      <button type="button" className="mer-btn" onClick={onNewArtifact}>
        <Sparkles className="h-4 w-4" aria-hidden="true" />
        New artifact
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
        {VIEWS.map((v) => (
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
  owner?: "shared";
  status?: "archived";
} {
  switch (view) {
    case "document":
      return { kind: "document" };
    case "artifact":
      return { kind: "artifact" };
    case "shared":
      return { owner: "shared" };
    case "archived":
      return { status: "archived" };
    default:
      return {};
  }
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

  return { items, loading, loadingMore, hasMore, error, fetchPage, refresh };
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

  const [view, setView] = useState<LibraryFilterView>("all");
  const [tag, setTag] = useState("");
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  // BOTH free-text filters are SERVER round-trips (#1336 moved the title search
  // server-side and widened it to match tags, so it now finds rows on page 2+
  // that a client-side filter over the already-loaded page could never see).
  const debouncedTag = useDebounced(tag);
  const debouncedSearch = useDebounced(search);

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
  } = useLibraryCreate(collectionId);

  // Derive the server filter from the active chip.
  const { kind, owner, status } = viewToFilter(view);
  const archivedView = view === "archived";

  const { items, loading, loadingMore, hasMore, error, fetchPage, refresh } =
    useLibraryPage({
      collectionId: collectionId ?? undefined,
      kind,
      owner,
      status,
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
      <section className="mx-auto min-w-0 max-w-6xl">
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

        <LibraryChips view={view} onView={setView} tag={tag} onTag={setTag} />

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

        {/* Pagination: hidden once a short page signals the end, while the first
            page loads, on error, or when the current filter matched nothing (a
            zero-result search must not render a dangling "Load more" — #1336). */}
        {hasMore && !loading && !error && items.length > 0 && (
          <div className="mt-5 flex justify-center">
            <button
              type="button"
              className={cn("mer-btn", loadingMore && "opacity-60")}
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </section>

      <CreateContentDialog
        key={agentPromptOpen ? "open" : "closed"}
        open={agentPromptOpen}
        onClose={() => setAgentPromptOpen(false)}
        onSubmit={handleAgentCreate}
      />
    </div>
  );
}
