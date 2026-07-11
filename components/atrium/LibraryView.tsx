"use client";

/**
 * Atrium LibraryView — the permission-filtered content library (spec §21),
 * restyled to the Meridian card grid (Epic #1059 redesign, slice B).
 *
 * The library lists exactly the content the requester may view (the list action
 * is permission-pushed via `canView`), with client-side title search, filter
 * chips (All / Docs / Artifacts / Shared with me — the last driven by the new
 * server-side `owner: "shared"` filter), a debounced tag filter, and
 * "New doc" / "New artifact" creation.
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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, Plus, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { listContentAction } from "@/actions/db/atrium/list-content";
import { createContentAction } from "@/actions/db/atrium/create-content";
import type { ContentObjectDTO, ContentKind } from "@/lib/content";
import { createLogger } from "@/lib/client-logger";
import { LibraryList } from "./LibraryList";
import { CreateContentDialog } from "./CreateContentDialog";

const log = createLogger({ component: "LibraryView" });

/**
 * The library filter chips. "shared" maps to the server `owner: "shared"`
 * ownership filter (content shared with the caller, not owned by them); the
 * others map to the `kind` filter (or no kind for "all").
 */
const VIEWS = [
  { value: "all", label: "All" },
  { value: "document", label: "Docs" },
  { value: "artifact", label: "Artifacts" },
  { value: "shared", label: "Shared with me" },
] as const;

type LibraryFilterView = (typeof VIEWS)[number]["value"];

/**
 * Server page size for the library list (Epic #1059 completion). Matches the
 * service default; "Load more" appends the next offset page.
 */
const PAGE_SIZE = 50;

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
}: {
  search: string;
  onSearch: (v: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onNewArtifact: () => void;
  onNewDoc: () => void;
}): React.JSX.Element {
  return (
    <header className="mer-lib-header">
      <h1 className="mer-lib-title">Content library</h1>
      <div className="mer-search">
        <Search className="mer-search-icon h-4 w-4" aria-hidden="true" />
        <input
          ref={searchRef}
          type="text"
          aria-label="Search content by title"
          placeholder="Search or ask the agent to find it…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
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
      <button type="button" className="mer-btn mer-btn-primary" onClick={onNewDoc}>
        <Plus className="h-4 w-4" aria-hidden="true" />
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
          className="h-9 w-28"
        />
        <span className="mer-sorted-label">Sorted by recent</span>
      </div>
    </div>
  );
}

export function LibraryView(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Section selection is URL-driven (`?collection=<id>`): the Meridian shell's
  // workspace nav column owns the tree and pushes the selection into the URL, and
  // the reader's collection sidebar deep-links here the same way. `useSearchParams`
  // already re-renders on any URL change, so reading the param directly (no local
  // state + sync effect) is all that's needed for the shell tree to drive the grid.
  const collectionId = searchParams.get("collection");

  const [view, setView] = useState<LibraryFilterView>("all");
  const [tag, setTag] = useState("");
  // Debounced copy of `tag`: the tag filter is a SERVER round-trip (unlike the
  // client-side title search), so feeding every keystroke into `load` fires a
  // request storm and flickers the list. Debounce 300ms before it reaches `load`.
  const [debouncedTag, setDebouncedTag] = useState("");
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedTag(tag), 300);
    return () => clearTimeout(t);
  }, [tag]);

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

  const [items, setItems] = useState<ContentObjectDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // Whether the LAST fetched page was full (== PAGE_SIZE rows): a short page
  // means the end was reached, so "Load more" hides.
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [createKind, setCreateKind] = useState<ContentKind | null>(null);

  // Monotonic sequence so a slow earlier response cannot overwrite a newer one.
  const reqSeqRef = useRef(0);

  // Derive the server filter from the active chip.
  const kind: ContentKind | undefined =
    view === "document" ? "document" : view === "artifact" ? "artifact" : undefined;
  const owner: "shared" | undefined = view === "shared" ? "shared" : undefined;

  /**
   * Fetch one page. `offset === 0` replaces the list (a fresh load for the
   * current filters); a non-zero offset APPENDS (the "Load more" path).
   */
  const fetchPage = useCallback(
    async (offset: number) => {
      const reqSeq = ++reqSeqRef.current;
      const append = offset > 0;
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);
      try {
        const res = await listContentAction({
          collectionId: collectionId ?? undefined,
          kind,
          owner,
          tag: debouncedTag.trim() || undefined,
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
    [collectionId, kind, owner, debouncedTag]
  );

  // Filters changed (or first mount): reload page one.
  useEffect(() => {
    void fetchPage(0);
  }, [fetchPage]);

  // Append the next offset page. `items.length` (not a page counter) is the
  // offset so a short final page can never skip rows.
  const loadMore = useCallback(() => {
    void fetchPage(items.length);
  }, [fetchPage, items.length]);

  // Client-side title search over the server-filtered set (kept local so typing
  // doesn't round-trip; the server already scoped to visible + filtered rows).
  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((it) => it.title.toLowerCase().includes(q));
  }, [items, search]);

  const handleCreate = useCallback(
    async (title: string): Promise<string | null> => {
      if (!createKind) return "No content kind selected";
      const res = await createContentAction({
        kind: createKind,
        title,
        collectionId: collectionId ?? undefined,
      });
      if (res.isSuccess) {
        router.push(`/atrium/${res.data.id}/edit`);
        return null;
      }
      log.warn("createContentAction failed", { message: res.message });
      return res.message ?? "Could not create content";
    },
    [createKind, collectionId, router]
  );

  return (
    <div className="w-full px-5 py-6 md:px-8 md:py-8">
      <section className="mx-auto min-w-0 max-w-6xl">
        <LibraryHeader
          search={search}
          onSearch={setSearch}
          searchRef={searchRef}
          onNewArtifact={() => setCreateKind("artifact")}
          onNewDoc={() => setCreateKind("document")}
        />

        <LibraryChips view={view} onView={setView} tag={tag} onTag={setTag} />

        <LibraryList
          items={visibleItems}
          loading={loading}
          error={error}
          onCreate={() => setCreateKind("document")}
        />

        {/* Pagination: hidden once a short page signals the end, while the first
            page loads, or on error. */}
        {hasMore && !loading && !error && (
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
        key={createKind ?? "closed"}
        kind={createKind}
        onClose={() => setCreateKind(null)}
        onCreate={handleCreate}
      />
    </div>
  );
}
