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
 * Selecting a collection calls `onSelect(node | null)` so a parent
 * (the library view) can filter its content list to that section. The "All
 * content" row selects `null` (no collection filter).
 *
 * The tree is fetched on mount via `collectionTreeAction`. Nodes with children
 * are expandable; a node also shows how many objects in it the viewer can see
 * (`visibleObjectCount`) as a subtle count.
 *
 * Expansion starts COLLAPSED and is remembered per viewer (`useExpandedSections`,
 * localStorage). It used to be a per-row `useState(true)`: every section unfolded
 * on every visit, and a collapse survived only until the next route change.
 *
 * Drag-and-drop (see `dnd/atrium-dnd.tsx`): every row is a drop target for
 * library cards and for other rows; the group headings are targets for "move to
 * the top level". Rows the viewer may manage (administrators for district
 * sections, owners for their private collections — the same rule as the
 * server's `assertMayManage`) also get a grip handle and take part in sibling
 * reordering. The provider performs the moves; this component only registers
 * targets, lights them up, and shows the provider's status line.
 */

import { useCallback, useEffect, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  GripVertical,
  Layers,
  Lock,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { collectionTreeAction } from "@/actions/db/atrium/collection-tree";
import type { CollectionTreeNode } from "@/lib/content";
import { createLogger } from "@/lib/client-logger";
import { useUser } from "@/components/auth/user-provider";
import { useExpandedSections } from "./use-expanded-sections";
import {
  intoId,
  rootId,
  useAtriumDnd,
  type DragPayload,
  type DropPayload,
} from "./dnd/atrium-dnd-context";

const log = createLogger({ component: "CollectionTree" });

/**
 * Who may move which rows — a mirror of the server's `assertMayManage`:
 * administrators manage district sections; a private collection is managed by
 * its owner (and by nobody else — not even an administrator). The server
 * re-checks on every drop; this only decides which rows get a grip handle.
 */
function useCanManageCollection(): {
  userId: number | null;
  canManage: (node: CollectionTreeNode) => boolean;
} {
  const { user, roles } = useUser();
  const isAdmin = roles.some((role) => role.name === "administrator");
  const userId = user?.id ?? null;
  const canManage = useCallback(
    (node: CollectionTreeNode): boolean =>
      node.scope === "private"
        ? userId !== null && node.ownerUserId === userId
        : isAdmin,
    [isAdmin, userId]
  );
  return { userId, canManage };
}

/** The provider's outcome line for the last drop (success or the server's refusal). */
function DndStatusLine(): React.JSX.Element | null {
  const { status } = useAtriumDnd();
  if (!status) return null;
  return (
    <p
      role="status"
      className="mer-tree-status px-2 py-1 text-xs"
      data-tone={status.tone}
      data-testid="tree-dnd-status"
    >
      {status.text}
    </p>
  );
}

/** Every id nested under a node — the set a dragged row may never land in. */
function descendantIdsOf(node: CollectionTreeNode): string[] {
  const out: string[] = [];
  const walk = (n: CollectionTreeNode) => {
    for (const child of n.children) {
      out.push(child.id);
      walk(child);
    }
  };
  walk(node);
  return out;
}

function scopeOf(node: CollectionTreeNode): "district" | "private" {
  return node.scope === "private" ? "private" : "district";
}

/**
 * A group heading ("Sections" / "My collections") that is also the "move to
 * the top level" drop target for its scope, and the "un-file" target for cards.
 */
function GroupHeading({
  scope,
  icon,
  label,
  className,
}: {
  scope: "district" | "private";
  icon: React.ReactNode;
  label: string;
  className?: string;
}): React.JSX.Element {
  const { active } = useAtriumDnd();
  const { setNodeRef, isOver } = useDroppable({
    id: rootId(scope),
    data: { kind: "root", scope } satisfies DropPayload,
  });
  return (
    <div
      ref={setNodeRef}
      data-drop-over={isOver && active ? "true" : undefined}
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground",
        className
      )}
    >
      {icon}
      {label}
    </div>
  );
}

interface CollectionTreeProps {
  /** Currently selected collection id, or null for "All content". */
  selectedCollectionId: string | null;
  /** Called when a section (or "All content") is chosen. */
  /**
   * Receives the whole NODE (not just its id) so callers can route by slug —
   * the section landing page lives at /atrium/s/[slug], and a readable, stable
   * URL beats a uuid in the query string. `null` means "All content".
   */
  onSelect: (node: CollectionTreeNode | null) => void;
  className?: string;
}

/** One row in the tree, recursively rendering its kept children. */
function TreeRow({
  node,
  depth,
  selectedCollectionId,
  onSelect,
  expandedIds,
  onToggle,
  siblingIds,
  canManage,
}: {
  node: CollectionTreeNode;
  depth: number;
  selectedCollectionId: string | null;
  /**
   * Receives the whole NODE (not just its id) so callers can route by slug —
   * the section landing page lives at /atrium/s/[slug], and a readable, stable
   * URL beats a uuid in the query string. `null` means "All content".
   */
  onSelect: (node: CollectionTreeNode | null) => void;
  /** Ids the viewer has expanded (tree-level, persisted) — see `useExpandedSections`. */
  expandedIds: ReadonlySet<string>;
  onToggle: (collectionId: string) => void;
  /** This row's whole sibling group in tree order — the drag-reorder payload. */
  siblingIds: string[];
  /** Whether the viewer may move a row (mirrors the server's `assertMayManage`). */
  canManage: (node: CollectionTreeNode) => boolean;
}): React.JSX.Element {
  const hasChildren = node.children.length > 0;
  const expanded = expandedIds.has(node.id);
  const isSelected = selectedCollectionId === node.id;
  const manageable = canManage(node);
  const { active } = useAtriumDnd();

  // Sortable (this row as something to drag) — disabled, not hidden, for rows
  // the viewer may not manage, so they still count as reorder targets' siblings.
  const dragPayload: DragPayload = {
    kind: "collection",
    id: node.id,
    name: node.name,
    parentId: node.parentId,
    scope: scopeOf(node),
    siblingIds,
    descendantIds: descendantIdsOf(node),
  };
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: node.id, data: dragPayload, disabled: !manageable });

  // Droppable (this row as somewhere to land). Registered on the row div, not
  // the <li>, so the nested children list is never part of the target rect.
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: intoId(node.id),
    data: {
      kind: "into",
      collectionId: node.id,
      scope: scopeOf(node),
      childCount: node.children.length,
    } satisfies DropPayload,
  });
  const childIds = node.children.map((child) => child.id);

  return (
    <li
      ref={setSortableRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      data-dragging={isDragging ? "true" : undefined}
    >
      <div
        ref={setDropRef}
        // `data-selected` is a stable styling hook: the Meridian shell restyles
        // the selected row via `.mer-navcol [data-selected="true"]` (see
        // styles/meridian.css) rather than depending on the Tailwind
        // utility class strings below, which have no compile-time link to that CSS
        // and are shared with the reader sidebar. It is inert everywhere else.
        data-selected={isSelected ? "true" : undefined}
        // Lit only while something is actually being dragged over it.
        data-drop-over={isOver && active ? "true" : undefined}
        data-testid={`section-row-${node.id}`}
        className={cn(
          "group/row flex items-center gap-1 rounded-md px-2 py-1.5 text-sm",
          isSelected
            ? "bg-accent text-accent-foreground font-medium"
            : "hover:bg-muted/60"
        )}
        style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={`section-children-${node.id}`}
            // Name the section in the label so a screen-reader user tabbing through
            // several chevrons can tell them apart (generic "Expand section" can't).
            aria-label={
              expanded ? `Collapse ${node.name}` : `Expand ${node.name}`
            }
            className="shrink-0 rounded p-1 hover:bg-muted"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
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
          onClick={() => onSelect(node)}
        >
          {/* A lock, not a folder, for an owner-bound private section. `scope`
              has always been on the node and was simply never read, so every
              section — yours alone or the whole district's — drew identically. */}
          {node.scope === "private" ? (
            <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
          ) : (
            <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{node.name}</span>
          {node.visibleObjectCount > 0 && (
            <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
              {node.visibleObjectCount}
            </span>
          )}
        </button>
        {manageable && (
          // The drag handle. Only the handle starts a drag, so clicking the
          // name still navigates and the chevron still toggles.
          <button
            type="button"
            className="mer-tree-grip shrink-0 rounded p-1 hover:bg-muted"
            aria-label={`Move ${node.name}`}
            title="Drag to move or reorder"
            data-testid={`move-collection-${node.id}`}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
      {hasChildren && expanded && (
        <SortableContext items={childIds} strategy={verticalListSortingStrategy}>
          <ul id={`section-children-${node.id}`}>
            {node.children.map((child) => (
              <TreeRow
                key={child.id}
                node={child}
                depth={depth + 1}
                selectedCollectionId={selectedCollectionId}
                onSelect={onSelect}
                expandedIds={expandedIds}
                onToggle={onToggle}
                siblingIds={childIds}
                canManage={canManage}
              />
            ))}
          </ul>
        </SortableContext>
      )}
    </li>
  );
}

/** One sibling group's rows: a sortable list, so drags reorder within it. */
function TreeRows({
  nodes,
  rowProps,
}: {
  nodes: CollectionTreeNode[];
  rowProps: Omit<
    React.ComponentProps<typeof TreeRow>,
    "node" | "depth" | "siblingIds"
  >;
}): React.JSX.Element {
  const ids = nodes.map((n) => n.id);
  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      <ul>
        {nodes.map((node) => (
          <TreeRow key={node.id} node={node} depth={0} siblingIds={ids} {...rowProps} />
        ))}
      </ul>
    </SortableContext>
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
  // Per-viewer, persisted expansion set. `user` resolves asynchronously from
  // UserProvider; until then the hook runs memory-only under an anonymous key,
  // and switches to the viewer's stored layout in the same commit `user` lands.
  const { userId, canManage } = useCanManageCollection();
  const [expandedIds, toggleExpanded] = useExpandedSections(userId);

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

  useEffect(() => {
    const reload = () => void load();
    window.addEventListener("atrium:collections-changed", reload);
    return () => window.removeEventListener("atrium:collections-changed", reload);
  }, [load]);

  // Split at the TOP level only: a private section's children are private by
  // construction, so grouping deeper would just repeat the same label.
  const districtNodes = tree.filter((n) => n.scope !== "private");
  const privateNodes = tree.filter((n) => n.scope === "private");
  const rowProps = {
    selectedCollectionId,
    onSelect,
    expandedIds,
    onToggle: toggleExpanded,
    canManage,
  };

  return (
    <nav
      aria-label="Content sections"
      className={cn("flex flex-col gap-1 text-sm", className)}
    >
      <GroupHeading
        scope="district"
        icon={<Layers className="h-3.5 w-3.5" />}
        label="Sections"
      />
      <ul>
        <li>
          <button
            type="button"
            onClick={() => onSelect(null)}
            data-selected={selectedCollectionId === null ? "true" : undefined}
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
      {!loading && districtNodes.length > 0 && (
        <TreeRows nodes={districtNodes} rowProps={rowProps} />
      )}

      {/* Owner-bound private sections get their OWN group. Intermixed with the
          shared tree there was no way to tell "a section the district can see"
          from "a folder only I can see" — the two were the same folder icon in
          one undifferentiated list. */}
      {!loading && privateNodes.length > 0 && (
        <>
          <GroupHeading
            scope="private"
            icon={<Lock className="h-3.5 w-3.5" />}
            label="My collections"
            className="mt-2"
          />
          <TreeRows nodes={privateNodes} rowProps={rowProps} />
        </>
      )}

      <DndStatusLine />
    </nav>
  );
}
