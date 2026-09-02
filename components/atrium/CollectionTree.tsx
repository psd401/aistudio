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
 * the top level". Rows the viewer may manage — `node.canManage`, computed by
 * the service from the same rule as its `assertMayManage` — also get a grip
 * handle and take part in sibling reordering. Each sibling list is a
 * `SortableContext`; a row's `groupIndex` is its index among the siblings that
 * share its owner, which is the group the server reorders. The provider
 * performs the moves; this component only registers typed targets, lights them
 * up, and shows the provider's status line.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDroppable, type Active } from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
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

/** The props every row needs and passes on to its children unchanged. */
interface RowProps {
  selectedCollectionId: string | null;
  onSelect: (node: CollectionTreeNode | null) => void;
  /** Ids the viewer has expanded (tree-level, persisted) — see `useExpandedSections`. */
  expandedIds: ReadonlySet<string>;
  onToggle: (collectionId: string) => void;
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

/**
 * Each node's index among the listed nodes that share its owner. A top-level
 * "My collections" list can hold another owner's collection shared into this
 * viewer's tree; it is not a sibling of the viewer's own, and the server
 * reorders per owner — so the index is per owner too.
 */
function groupIndices(nodes: CollectionTreeNode[]): Map<string, number> {
  const next = new Map<number | null, number>();
  const out = new Map<string, number>();
  for (const node of nodes) {
    const i = next.get(node.ownerUserId) ?? 0;
    out.set(node.id, i);
    next.set(node.ownerUserId, i + 1);
  }
  return out;
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
  const { setNodeRef, isOver } = useDroppable({
    id: rootId(scope),
    data: { kind: "root", scope } satisfies DropPayload,
  });
  return (
    <div
      ref={setNodeRef}
      data-drop-over={isOver ? "true" : undefined}
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

/** One row in the tree, recursively rendering its kept children. */
/**
 * When this row is the sortable (reorder) target, which edge the dragged
 * sibling will take: "before" if it is moving up the group, "after" if down.
 */
function slotEdgeFor(
  isTarget: boolean,
  active: Active | null,
  groupIndex: number
): "before" | "after" | undefined {
  const drag = active?.data.current as DragPayload | undefined;
  if (!isTarget || drag?.kind !== "collection") return undefined;
  return drag.groupIndex > groupIndex ? "before" : "after";
}

function TreeRow({
  node,
  depth,
  groupIndex,
  ...rowProps
}: RowProps & {
  node: CollectionTreeNode;
  depth: number;
  groupIndex: number;
}): React.JSX.Element {
  const { selectedCollectionId, onSelect, expandedIds, onToggle } = rowProps;
  const hasChildren = node.children.length > 0;
  const expanded = expandedIds.has(node.id);
  const isSelected = selectedCollectionId === node.id;

  // Node identity is stable until the next tree load, so the subtree walk and
  // the payloads are computed once per load, not once per render.
  const descendantIds = useMemo(() => descendantIdsOf(node), [node]);
  const dragPayload = useMemo<DragPayload>(
    () => ({
      kind: "collection",
      id: node.id,
      name: node.name,
      parentId: node.parentId,
      ownerUserId: node.ownerUserId,
      scope: node.scope,
      groupIndex,
      descendantIds,
    }),
    [node, groupIndex, descendantIds]
  );
  const dropPayload = useMemo<DropPayload>(
    () => ({
      kind: "into",
      collectionId: node.id,
      name: node.name,
      parentId: node.parentId,
      ownerUserId: node.ownerUserId,
      scope: node.scope,
    }),
    [node]
  );

  // Sortable (this row as something to drag) — disabled, not hidden, for rows
  // the viewer may not manage, so they still take part in the list's layout.
  //
  // The displacement `transform` dnd-kit offers is deliberately NOT applied:
  // rows stay put during a drag and the overlay ghost is the only thing that
  // moves. Sliding rows apart would draw a sibling over the dragged row's
  // original slot while collision detection keeps working from the original
  // layout — the visible middle band of the displaced sibling would then map
  // to the dragged row's own rect, and nesting into that sibling would resolve
  // as a reorder. Reorder targets get an insertion line instead
  // (`data-drop-edge`); nest targets keep the row highlight.
  const {
    attributes,
    listeners,
    setNodeRef: setSortableRef,
    isDragging,
    isOver: isSlotTarget,
    active,
  } = useSortable({ id: node.id, data: dragPayload, disabled: !node.canManage });
  const slotEdge = slotEdgeFor(isSlotTarget, active, groupIndex);

  // Droppable (this row as somewhere to land). Registered on the row div, not
  // the <li>, so the nested children list is never part of the target rect.
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: intoId(node.id),
    data: dropPayload,
  });

  return (
    <li ref={setSortableRef} data-dragging={isDragging ? "true" : undefined}>
      <div
        ref={setDropRef}
        // `data-selected` is a stable styling hook: the Meridian shell restyles
        // the selected row via `.mer-navcol [data-selected="true"]` (see
        // styles/meridian.css) rather than depending on the Tailwind
        // utility class strings below, which have no compile-time link to that CSS
        // and are shared with the reader sidebar. It is inert everywhere else.
        data-selected={isSelected ? "true" : undefined}
        // dnd-kit only reports `isOver` while a drag is in progress.
        data-drop-over={isOver ? "true" : undefined}
        // A sibling about to take this row's slot: a line above (moving up)
        // or below (moving down) rather than a highlight.
        data-drop-edge={slotEdge}
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
        {node.canManage && (
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
        <TreeRows
          nodes={node.children}
          depth={depth + 1}
          listId={`section-children-${node.id}`}
          rowProps={rowProps}
        />
      )}
    </li>
  );
}

/** One sibling list — a sortable context — for a top-level group or a node's children. */
function TreeRows({
  nodes,
  depth,
  listId,
  rowProps,
}: {
  nodes: CollectionTreeNode[];
  depth: number;
  listId?: string;
  rowProps: RowProps;
}): React.JSX.Element {
  const ids = nodes.map((n) => n.id);
  const indexById = groupIndices(nodes);
  return (
    <SortableContext items={ids} strategy={verticalListSortingStrategy}>
      <ul id={listId}>
        {nodes.map((node) => (
          <TreeRow
            key={node.id}
            node={node}
            depth={depth}
            groupIndex={indexById.get(node.id) ?? 0}
            {...rowProps}
          />
        ))}
      </ul>
    </SortableContext>
  );
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
  const { user } = useUser();
  const [expandedIds, toggleExpanded] = useExpandedSections(user?.id ?? null);

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
  const rowProps: RowProps = {
    selectedCollectionId,
    onSelect,
    expandedIds,
    onToggle: toggleExpanded,
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
        <TreeRows nodes={districtNodes} depth={0} rowProps={rowProps} />
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
          <TreeRows nodes={privateNodes} depth={0} rowProps={rowProps} />
        </>
      )}

      <DndStatusLine />
    </nav>
  );
}
