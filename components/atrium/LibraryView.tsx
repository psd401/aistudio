"use client";

/**
 * Atrium LibraryView — the permission-filtered content library (spec §21)
 *
 * Issue #1054 (Epic #1059, Atrium Phase 4). The library lists exactly the content
 * the requester may view (the list action is permission-pushed via `canView`),
 * with client-side title search and server-side filters by kind / collection /
 * tag, plus "New doc" / "New artifact" creation that calls `contentService.create`
 * through the create-content action and routes to the editor.
 *
 * The `CollectionTree` sidebar (also visibility-filtered) selects a collection to
 * filter by; "All content" clears the section filter. Authorization is entirely
 * server-side — this component renders only what the actions return.
 *
 * Pagination (Epic #1059 completion): the list is fetched in 50-row pages
 * (limit/offset through `listContentAction`) with a "Load more" append control;
 * any server-side filter change resets to page one. `?collection=<id>` deep-links
 * a section selection (the reader sidebar links here).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { listContentAction } from "@/actions/db/atrium/list-content";
import { createContentAction } from "@/actions/db/atrium/create-content";
import type { ContentObjectDTO, ContentKind } from "@/lib/content";
import { createLogger } from "@/lib/client-logger";
import { LibraryList } from "./LibraryList";
import { CreateContentDialog } from "./CreateContentDialog";

const log = createLogger({ component: "LibraryView" });

/** Kind filter options for the library (all = no kind filter). */
const KIND_FILTERS = [
  { value: "all", label: "All kinds" },
  { value: "document", label: "Docs" },
  { value: "artifact", label: "Artifacts" },
] as const;

type KindFilter = (typeof KIND_FILTERS)[number]["value"];

/**
 * Server page size for the library list (Epic #1059 completion). Matches the
 * service default; "Load more" appends the next offset page. A short page
 * (< PAGE_SIZE rows) means the end was reached and the control hides.
 */
const PAGE_SIZE = 50;

/**
 * The filter row: client-side title search + server-side kind/tag filters.
 * Extracted from LibraryView so its body stays under the max-lines-per-function
 * lint; purely presentational — all state lives in the parent.
 */
function LibraryFilters({
  search,
  onSearch,
  kind,
  onKind,
  tag,
  onTag,
}: {
  search: string;
  onSearch: (v: string) => void;
  kind: KindFilter;
  onKind: (v: KindFilter) => void;
  tag: string;
  onTag: (v: string) => void;
}): React.JSX.Element {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <div className="relative min-w-[12rem] flex-1">
        <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Search content by title"
          placeholder="Search by title…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="pl-8"
        />
      </div>
      <Select value={kind} onValueChange={(v) => onKind(v as KindFilter)}>
        <SelectTrigger className="w-36" aria-label="Filter by kind">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {KIND_FILTERS.map((k) => (
            <SelectItem key={k.value} value={k.value}>
              {k.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        aria-label="Filter by tag"
        placeholder="Tag…"
        value={tag}
        onChange={(e) => onTag(e.target.value)}
        className="w-32"
      />
    </div>
  );
}

export function LibraryView(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Section selection is URL-driven (`?collection=<id>`): the Meridian shell's
  // workspace nav column (a separate React subtree in `atrium/layout.tsx`) owns
  // the section tree and pushes the selection into the URL, and the reader's
  // collection sidebar deep-links here the same way. Reading it reactively (not
  // mount-once) is what lets the shell tree drive this grid — a `?collection=`
  // change re-seeds `collectionId`, which re-keys `fetchPage` and reloads page
  // one. `useSearchParams` returns the param on the SSR pass (force-dynamic) and
  // on hydration, so server and client agree with no hydration mismatch.
  const collectionParam = searchParams.get("collection");
  const [collectionId, setCollectionId] = useState<string | null>(
    collectionParam
  );
  useEffect(() => {
    setCollectionId(collectionParam);
  }, [collectionParam]);
  const [kind, setKind] = useState<KindFilter>("all");
  const [tag, setTag] = useState("");
  // Debounced copy of `tag`: the tag filter is a SERVER round-trip (unlike the
  // client-side title search), so feeding every keystroke into `load` fires a
  // request storm and flickers the list. Debounce 300ms before it reaches `load`.
  const [debouncedTag, setDebouncedTag] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedTag(tag), 300);
    return () => clearTimeout(t);
  }, [tag]);

  const [items, setItems] = useState<ContentObjectDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  // Whether the LAST fetched page was full (== PAGE_SIZE rows): a short page
  // means the end was reached, so "Load more" hides.
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [createKind, setCreateKind] = useState<ContentKind | null>(null);

  // Monotonic sequence so a slow earlier response cannot overwrite a newer one
  // (filters change rapidly, and a filter change mid-"Load more" must discard
  // the stale append). Each load captures its seq and discards a stale result.
  // (Named `reqSeq`, not `token`, to avoid a false-positive timing-attack lint
  // on the comparison.)
  const reqSeqRef = useRef(0);

  /**
   * Fetch one page. `offset === 0` replaces the list (a fresh load for the
   * current filters); a non-zero offset APPENDS (the "Load more" path, which
   * preserves the already-rendered pages under the same filters).
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
          kind: kind === "all" ? undefined : kind,
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
    [collectionId, kind, debouncedTag]
  );

  // Filters changed (or first mount): reload page one. `fetchPage`'s identity
  // changes exactly when a server-side filter changes, so this both resets
  // pagination and re-queries.
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
        // Place the new object in the currently-selected section (if any) so it
        // lands where the user is browsing; visibility defaults to the collection
        // default (else private) in the service.
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
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <h1 className="mr-auto text-2xl font-semibold">Content library</h1>
          <Button size="sm" onClick={() => setCreateKind("document")}>
            New doc
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setCreateKind("artifact")}
          >
            New artifact
          </Button>
        </header>

        <LibraryFilters
          search={search}
          onSearch={setSearch}
          kind={kind}
          onKind={setKind}
          tag={tag}
          onTag={setTag}
        />

        <LibraryList items={visibleItems} loading={loading} error={error} />

        {/* Pagination (Epic #1059 completion): hidden once a short page signals
            the end, while the first page loads, or on error. Appends under the
            CURRENT filters; a filter change resets to page one. */}
        {hasMore && !loading && !error && (
          <div className="mt-4 flex justify-center">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
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
