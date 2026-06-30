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
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
import { CollectionTree } from "@/components/atrium/CollectionTree";
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

export function LibraryView(): React.JSX.Element {
  const router = useRouter();

  const [collectionId, setCollectionId] = useState<string | null>(null);
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
  const [error, setError] = useState<string | null>(null);

  const [createKind, setCreateKind] = useState<ContentKind | null>(null);

  // Monotonic sequence so a slow earlier response cannot overwrite a newer one
  // (filters change rapidly). Each load captures its seq and discards a stale
  // result. (Named `reqSeq`, not `token`, to avoid a false-positive timing-attack
  // lint on the comparison.)
  const reqSeqRef = useRef(0);

  const load = useCallback(async () => {
    const reqSeq = ++reqSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await listContentAction({
        collectionId: collectionId ?? undefined,
        kind: kind === "all" ? undefined : kind,
        tag: debouncedTag.trim() || undefined,
      });
      if (reqSeq !== reqSeqRef.current) return; // stale response — drop it
      if (res.isSuccess) {
        setItems(res.data);
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
      if (reqSeq === reqSeqRef.current) setLoading(false);
    }
  }, [collectionId, kind, debouncedTag]);

  useEffect(() => {
    void load();
  }, [load]);

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
    <div className="flex w-full gap-6">
      <aside className="hidden w-60 shrink-0 border-r pr-4 md:block">
        <CollectionTree
          selectedCollectionId={collectionId}
          onSelect={setCollectionId}
        />
      </aside>

      <section className="min-w-0 flex-1">
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

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[12rem] flex-1">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search content by title"
              placeholder="Search by title…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <Select value={kind} onValueChange={(v) => setKind(v as KindFilter)}>
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
            onChange={(e) => setTag(e.target.value)}
            className="w-32"
          />
        </div>

        <LibraryList items={visibleItems} loading={loading} error={error} />
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
