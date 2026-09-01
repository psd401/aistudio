"use client";

/**
 * Atrium drag-and-drop — one DndContext over the whole shell.
 *
 * Two gestures, one provider:
 *  - Drag a LIBRARY CARD onto a section in the sidebar tree → the object moves
 *    into that section (`updateContentAction(id, { collectionId })`); onto a
 *    group heading ("Sections" / "My collections") → it is un-filed.
 *  - Drag a SECTION ROW: onto another row's middle band (or anywhere on a row
 *    that is not its sibling) → it is nested inside that section; onto a group
 *    heading → it moves to the top level; onto a sibling's top/bottom edge →
 *    the sibling group is reordered (`reorderCollectionsAction`).
 *
 * The provider lives in `AtriumShell` because the tree (nav column) and the
 * grid (page content) are siblings there — a drag has to cross that boundary.
 * Tree rows register droppables (`into:<id>`, plus `root:<scope>` headings) and
 * sortables (their own id); cards register draggables (`content:<id>`). The
 * ids, payload types and context live in `atrium-dnd-context.ts`.
 *
 * Permission is enforced server-side (`assertMayManage`, `assertNoCycle`, the
 * private-collection visibility rule in `applyCollectionChangeInTx`); the
 * client only hides handles it knows would be refused and shows the server's
 * message when a drop is rejected. Feedback is an inline status line (Atrium
 * uses no toasts), rendered by the tree.
 *
 * Sensors: mouse (small distance threshold so clicks still click), touch (a
 * hold before the drag starts, so the list still scrolls), keyboard.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { FolderOpen, FileText } from "lucide-react";
import { updateContentAction } from "@/actions/db/atrium/update-content";
import {
  reorderCollectionsAction,
  updateCollectionAction,
} from "@/actions/db/atrium/collection-management";
import { createLogger } from "@/lib/client-logger";
import {
  AtriumDndContext,
  type DndStatus,
  type DragPayload,
  type DropPayload,
} from "./atrium-dnd-context";

const log = createLogger({ component: "AtriumDnd" });

type ContentDrag = Extract<DragPayload, { kind: "content" }>;
type CollectionDrag = Extract<DragPayload, { kind: "collection" }>;

/** Ask the tree and the grid to re-fetch after a successful drop. */
function announceMoved(kind: DragPayload["kind"]): void {
  window.dispatchEvent(new Event("atrium:collections-changed"));
  if (kind === "content") window.dispatchEvent(new Event("atrium:content-moved"));
}

/**
 * Which target a pointer is over — the one decision that makes the two
 * gestures feel right.
 *
 * Cards: only sections and group headings are targets; whatever the pointer
 * is inside wins.
 *
 * Section rows: a group heading, or a row that is NOT a sibling, is a nest
 * target anywhere on it. A SIBLING row is a nest target only in its vertical
 * middle band; its top/bottom quarters mean "put me before/after this" and fall
 * through to the ordinary sortable reorder among the siblings. The dragged row
 * itself and everything nested under it are never targets (a cycle).
 */
const atriumCollision: CollisionDetection = (args) => {
  const active = args.active.data.current as DragPayload | undefined;
  if (!active) return [];
  const within = pointerWithin(args).filter((c) => {
    const id = String(c.id);
    return id.startsWith("into:") || id.startsWith("root:");
  });

  if (active.kind === "content") return within.slice(0, 1);

  const y = args.pointerCoordinates?.y ?? null;
  const excluded = new Set([active.id, ...active.descendantIds]);
  for (const collision of within) {
    const id = String(collision.id);
    if (id.startsWith("root:")) return [collision];
    const targetId = id.slice("into:".length);
    if (excluded.has(targetId)) continue;
    if (!active.siblingIds.includes(targetId)) return [collision];
    const rect = args.droppableRects.get(collision.id);
    if (rect && y !== null) {
      const band = rect.height * 0.25;
      if (y > rect.top + band && y < rect.bottom - band) return [collision];
    }
  }

  const siblings = args.droppableContainers.filter((c) =>
    active.siblingIds.includes(String(c.id))
  );
  return closestCenter({ ...args, droppableContainers: siblings });
};

function failure(message: string | undefined, fallback: string): DndStatus {
  return { tone: "error", text: message ?? fallback };
}

async function dropContent(
  active: ContentDrag,
  overId: string
): Promise<DndStatus | null> {
  const target = overId.startsWith("into:")
    ? overId.slice("into:".length)
    : overId.startsWith("root:")
      ? null
      : undefined;
  if (target === undefined || target === active.collectionId) return null;
  const res = await updateContentAction(active.id, { collectionId: target });
  if (!res.isSuccess) return failure(res.message, "Could not move the item");
  announceMoved("content");
  return {
    tone: "ok",
    text: target
      ? `Moved “${active.title}”`
      : `Removed “${active.title}” from its section`,
  };
}

async function nestCollection(
  active: CollectionDrag,
  parentId: string,
  over: DropPayload | undefined
): Promise<DndStatus | null> {
  if (parentId === active.parentId) return null;
  // Land as the LAST child: positions are dense, so the next free slot is the
  // current child count (the same rule as the service's `nextPosition`).
  const position = over?.kind === "into" ? over.childCount : 0;
  const res = await updateCollectionAction(active.id, { parentId, position });
  if (!res.isSuccess) return failure(res.message, "Could not move the section");
  announceMoved("collection");
  return { tone: "ok", text: `Moved “${active.name}”` };
}

async function unnestCollection(active: CollectionDrag): Promise<DndStatus | null> {
  if (active.parentId === null) return null;
  const res = await updateCollectionAction(active.id, { parentId: null });
  if (!res.isSuccess) return failure(res.message, "Could not move the section");
  announceMoved("collection");
  return { tone: "ok", text: `Moved “${active.name}” to the top level` };
}

async function reorderSiblings(
  active: CollectionDrag,
  overId: string
): Promise<DndStatus | null> {
  const from = active.siblingIds.indexOf(active.id);
  const to = active.siblingIds.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  const res = await reorderCollectionsAction(
    arrayMove(active.siblingIds, from, to)
  );
  if (!res.isSuccess) return failure(res.message, "Could not reorder the sections");
  announceMoved("collection");
  return { tone: "ok", text: `Reordered “${active.name}”` };
}

/** Run the drop the user made; returns the status line to show (or nothing). */
async function executeDrop(
  active: DragPayload,
  overId: string,
  over: DropPayload | undefined
): Promise<DndStatus | null> {
  if (active.kind === "content") return dropContent(active, overId);
  if (overId.startsWith("into:")) {
    return nestCollection(active, overId.slice("into:".length), over);
  }
  if (overId.startsWith("root:")) return unnestCollection(active);
  return reorderSiblings(active, overId);
}

const STATUS_TTL_MS = 4000;

export function AtriumDndProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const [active, setActive] = useState<DragPayload | null>(null);
  const [status, setStatus] = useState<DndStatus | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sensors = useSensors(
    // A small threshold so a plain click on a handle is still a click.
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // Hold-to-drag on touch: a quick swipe must still scroll the list.
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const showStatus = useCallback((next: DndStatus | null) => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setStatus(next);
    if (next) {
      statusTimer.current = setTimeout(() => setStatus(null), STATUS_TTL_MS);
    }
  }, []);

  useEffect(
    () => () => {
      if (statusTimer.current) clearTimeout(statusTimer.current);
    },
    []
  );

  const onDragStart = useCallback((event: DragStartEvent) => {
    setActive((event.active.data.current as DragPayload | undefined) ?? null);
  }, []);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const payload = event.active.data.current as DragPayload | undefined;
      setActive(null);
      if (!payload || !event.over) return;
      const overId = String(event.over.id);
      const over = event.over.data.current as DropPayload | undefined;
      void executeDrop(payload, overId, over)
        .then((result) => {
          if (result) showStatus(result);
        })
        .catch((e) => {
          log.error("drop failed", {
            error: e instanceof Error ? e.message : String(e),
          });
          showStatus({ tone: "error", text: "Could not complete the move" });
        });
    },
    [showStatus]
  );

  const onDragCancel = useCallback(() => setActive(null), []);

  const value = useMemo(() => ({ active, status }), [active, status]);

  return (
    <AtriumDndContext.Provider value={value}>
      <DndContext
        sensors={sensors}
        collisionDetection={atriumCollision}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        {children}
        <DragOverlay dropAnimation={null}>
          {active ? (
            <div className="mer-drag-ghost" role="presentation">
              {active.kind === "content" ? (
                <FileText className="h-4 w-4" aria-hidden="true" />
              ) : (
                <FolderOpen className="h-4 w-4" aria-hidden="true" />
              )}
              <span className="truncate">
                {active.kind === "content" ? active.title : active.name}
              </span>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </AtriumDndContext.Provider>
  );
}
