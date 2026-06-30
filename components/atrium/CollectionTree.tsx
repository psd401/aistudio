"use client";

/**
 * Atrium CollectionTree — the visibility-filtered intranet section sidebar
 *
 * Issue #1054 (Epic #1059, Atrium Phase 4, spec §21). Renders the collection tree
 * (the intranet section tree) the requester may enter. The tree is ALREADY
 * permission-filtered server-side by `collectionService.tree` (a section the user
 * cannot enter is pruned), so this component is presentation only — it never makes
 * an authorization decision and never receives a section the viewer cannot see.
 *
 * Selecting a collection calls `onSelect(collectionId | null)` so a parent
 * (the library view) can filter its content list to that section. The "All
 * content" row selects `null` (no collection filter).
 *
 * The tree is fetched on mount via `collectionTreeAction`. Nodes with children
 * are expandable; a node also shows how many objects in it the viewer can see
 * (`visibleObjectCount`) as a subtle count.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FolderOpen, Layers } from "lucide-react";
import { cn } from "@/lib/utils";
import { collectionTreeAction } from "@/actions/db/atrium/collection-tree";
import type { CollectionTreeNode } from "@/lib/content";
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "CollectionTree" });

interface CollectionTreeProps {
  /** Currently selected collection id, or null for "All content". */
  selectedCollectionId: string | null;
  /** Called when a section (or "All content") is chosen. */
  onSelect: (collectionId: string | null) => void;
  className?: string;
}

/** One row in the tree, recursively rendering its kept children. */
function TreeRow({
  node,
  depth,
  selectedCollectionId,
  onSelect,
}: {
  node: CollectionTreeNode;
  depth: number;
  selectedCollectionId: string | null;
  onSelect: (collectionId: string | null) => void;
}): React.JSX.Element {
  const hasChildren = node.children.length > 0;
  const [expanded, setExpanded] = useState(true);
  const isSelected = selectedCollectionId === node.id;

  return (
    <li>
      <div
        className={cn(
          "flex items-center gap-1 rounded-md px-2 py-1.5 text-sm",
          isSelected
            ? "bg-accent text-accent-foreground font-medium"
            : "hover:bg-muted/60"
        )}
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? "Collapse section" : "Expand section"}
            className="shrink-0 rounded p-0.5 hover:bg-muted"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          onClick={() => onSelect(node.id)}
        >
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.name}</span>
          {node.visibleObjectCount > 0 && (
            <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
              {node.visibleObjectCount}
            </span>
          )}
        </button>
      </div>
      {hasChildren && expanded && (
        <ul>
          {node.children.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedCollectionId={selectedCollectionId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

export function CollectionTree({
  selectedCollectionId,
  onSelect,
  className,
}: CollectionTreeProps): React.JSX.Element {
  const [tree, setTree] = useState<CollectionTreeNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await collectionTreeAction();
      if (res.isSuccess) {
        setTree(res.data);
      } else {
        setError(res.message ?? "Could not load sections");
        log.warn("collectionTreeAction failed", { message: res.message });
      }
    } catch (e) {
      setError("Could not load sections");
      log.error("collectionTreeAction threw", {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <nav
      aria-label="Content sections"
      className={cn("flex flex-col gap-1 text-sm", className)}
    >
      <div className="flex items-center gap-1.5 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Layers className="h-3.5 w-3.5" />
        Sections
      </div>
      <ul>
        <li>
          <button
            type="button"
            onClick={() => onSelect(null)}
            className={cn(
              "flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left",
              selectedCollectionId === null
                ? "bg-accent text-accent-foreground font-medium"
                : "hover:bg-muted/60"
            )}
            style={{ paddingLeft: "0.5rem" }}
          >
            <span className="w-4 shrink-0" />
            <Layers className="h-4 w-4 shrink-0 text-muted-foreground" />
            All content
          </button>
        </li>
      </ul>

      {loading && (
        <p className="px-2 py-1 text-xs text-muted-foreground">Loading sections…</p>
      )}
      {error && !loading && (
        <p className="px-2 py-1 text-xs text-destructive">{error}</p>
      )}
      {!loading && !error && tree.length === 0 && (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          No sections you can enter yet.
        </p>
      )}
      {!loading && tree.length > 0 && (
        <ul>
          {tree.map((node) => (
            <TreeRow
              key={node.id}
              node={node}
              depth={0}
              selectedCollectionId={selectedCollectionId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </nav>
  );
}
