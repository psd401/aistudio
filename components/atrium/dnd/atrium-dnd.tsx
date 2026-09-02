"use client";

/**
 * Atrium drag-and-drop — one DndContext over the whole shell.
 *
 * Two gestures, one provider:
 *  - Drag a LIBRARY CARD onto a section in the sidebar tree → the object moves
 *    into that section (`updateContentAction(id, { collectionId })`); onto a
 *    group heading ("Sections" / "My collections") → it is un-filed.
 *  - Drag a SECTION ROW: onto another row's middle band (or anywhere on a row
 *    that is not its sibling) → it is nested inside that section; onto its own
 *    group's heading → it moves to the top level; onto a sibling's top/bottom
 *    edge → it takes that sibling's slot (`moveCollectionAction`).
 *
 * The provider lives in `AtriumShell` because the tree (nav column) and the
 * grid (page content) are siblings there — a drag has to cross that boundary.
 * Every target carries a typed payload (`atrium-dnd-context.ts`); which
 * targets a drag may land on, and which one the pointer means, is decided in
 * `atriumCollision` from those payloads — scope, ownership and ancestry are
 * all known client-side, so a target the server would refuse never lights up.
 *
 * Positions are the server's business: a nest/un-nest sends only the new
 * parent (the service appends), and a reorder sends only the target index
 * (the service resolves the live sibling group). Permission is enforced
 * server-side on every drop; the client only hides handles it knows would be
 * refused (`node.canManage`) and shows the server's message when a drop is
 * still rejected. Feedback is an inline status line (Atrium uses no toasts).
 *
 * Sensors: mouse (small distance threshold so clicks still click), touch (a
 * hold before the drag starts, so the list still scrolls), keyboard (with a
 * closest-center fallback, since a keyboard drag has no pointer).
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
  type Announcements,
  type Collision,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type DroppableContainer,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { FolderOpen, FileText } from "lucide-react";
import { updateContentAction } from "@/actions/db/atrium/update-content";
import {
  moveCollectionAction,
  updateCollectionAction,
} from "@/actions/db/atrium/collection-management";
import { createLogger } from "@/lib/client-logger";
import {
  AtriumDndContext,
  intoId,
  type DndStatus,
  type DragPayload,
  type TargetPayload,
} from "./atrium-dnd-context";

const log = createLogger({ component: "AtriumDnd" });

type ContentDrag = Extract<DragPayload, { kind: "content" }>;
type CollectionDrag = Extract<DragPayload, { kind: "collection" }>;

function targetOf(container: DroppableContainer): TargetPayload | undefined {
  return container.data.current as TargetPayload | undefined;
}

function labelOf(payload: DragPayload | TargetPayload | undefined): string {
  if (!payload) return "nothing";
  switch (payload.kind) {
    case "content":
      return `“${payload.title}”`;
    case "collection":
      return `section “${payload.name}”`;
    case "into":
      return `section “${payload.name}”`;
    case "root":
      return payload.scope === "private" ? "the top of My collections" : "the top of Sections";
  }
}

/** Ask the tree and the grid to re-fetch after a successful drop. */
function announceMoved(kind: DragPayload["kind"]): void {
  window.dispatchEvent(new Event("atrium:collections-changed"));
  if (kind === "content") window.dispatchEvent(new Event("atrium:content-moved"));
}

function sameGroup(a: CollectionDrag, t: { parentId: string | null; ownerUserId: number | null }): boolean {
  return t.parentId === a.parentId && t.ownerUserId === a.ownerUserId;
}

/**
 * May `active` land on `target` at all? Everything the server would refuse
 * on structural grounds is excluded here, so it never highlights: the row
 * itself and its descendants (a cycle), the other scope's rows and heading
 * (private and district hierarchies cannot mix), another owner's private
 * collection (never a legal parent, and not a sibling either — a shared
 * private collection sitting next to the viewer's own is neither), and — for
 * sibling reorder — rows outside the live group.
 */
function accepts(active: DragPayload, target: TargetPayload | undefined): boolean {
  if (!target) return false;
  if (active.kind === "content") return target.kind === "into" || target.kind === "root";
  switch (target.kind) {
    case "root":
      return target.scope === active.scope;
    case "into":
      return (
        target.scope === active.scope &&
        target.collectionId !== active.id &&
        !active.descendantIds.includes(target.collectionId) &&
        // A private hierarchy never crosses owners: `assertParent` masks
        // another owner's private collection as "Parent collection not
        // found", so a SHARED private collection sitting alongside the
        // viewer's own in "My collections" is never a legal parent. Without
        // this it highlighted as a nest target and the drop always failed.
        // (`sameGroup` already applies the same rule to sibling reorder.)
        (active.scope !== "private" || target.ownerUserId === active.ownerUserId)
      );
    case "collection":
      return target.id !== active.id && sameGroup(active, target);
  }
}

/**
 * Which target the pointer means.
 *
 * Cards: whichever section row or heading the pointer is inside.
 *
 * Section rows: a heading, or a row that is NOT a sibling, is a nest target
 * anywhere on it. A SIBLING row is a nest target only in its vertical middle
 * band; its top/bottom quarters mean "put me in this slot" and resolve to the
 * sibling whose ROW (not its expanded subtree) is nearest the pointer. A
 * keyboard drag has no pointer, so it falls back to closest-center over every
 * acceptable target.
 */
type CollisionArgs = Parameters<CollisionDetection>[0];

/**
 * For a section drag, does this zone hit mean "nest here" (true) or "this
 * is a sibling's edge — reorder instead" (false)?
 */
function isNestHit(active: CollectionDrag, hit: Collision, args: CollisionArgs, pointerY: number): boolean {
  const container = hit.data?.droppableContainer as DroppableContainer | undefined;
  const target = container ? targetOf(container) : undefined;
  if (!target || target.kind === "root") return true;
  if (target.kind !== "into") return false;
  if (!sameGroup(active, target)) return true;
  const rect = args.droppableRects.get(hit.id);
  if (!rect) return false;
  const band = rect.height * 0.25;
  return pointerY > rect.top + band && pointerY < rect.bottom - band;
}

/** The sibling whose ROW rect (its `into:` droppable, not the <li> with children) is nearest the pointer. */
function nearestSibling(
  containers: DroppableContainer[],
  args: CollisionArgs,
  pointerY: number
): Collision[] {
  let best: { container: DroppableContainer; distance: number } | null = null;
  for (const container of containers) {
    const target = targetOf(container);
    if (target?.kind !== "collection") continue;
    const rect = args.droppableRects.get(intoId(target.id));
    if (!rect) continue;
    const distance = Math.abs(pointerY - (rect.top + rect.height / 2));
    if (!best || distance < best.distance) best = { container, distance };
  }
  return best
    ? [{ id: best.container.id, data: { droppableContainer: best.container, value: best.distance } }]
    : [];
}

const atriumCollision: CollisionDetection = (args) => {
  const active = args.active.data.current as DragPayload | undefined;
  if (!active) return [];
  const containers = args.droppableContainers.filter((c) => accepts(active, targetOf(c)));
  const pointer = args.pointerCoordinates;
  if (!pointer) return closestCenter({ ...args, droppableContainers: containers });

  const zones = containers.filter((c) => targetOf(c)?.kind !== "collection");
  const within = pointerWithin({ ...args, droppableContainers: zones });
  if (active.kind === "content") return within.slice(0, 1);

  // Still over the row being dragged (where the press began): no target yet,
  // rather than lighting up the nearest sibling before the user has moved.
  const own = args.droppableRects.get(intoId(active.id));
  if (own && pointer.y >= own.top && pointer.y <= own.bottom && pointer.x >= own.left && pointer.x <= own.right) {
    return [];
  }

  const nest = within.find((hit) => isNestHit(active, hit, args, pointer.y));
  return nest ? [nest] : nearestSibling(containers, args, pointer.y);
};

function failure(message: string | undefined, fallback: string): DndStatus {
  return { tone: "error", text: message ?? fallback };
}

async function dropContent(active: ContentDrag, over: TargetPayload): Promise<DndStatus | null> {
  if (over.kind !== "into" && over.kind !== "root") return null;
  const collectionId = over.kind === "into" ? over.collectionId : null;
  if (collectionId === active.collectionId) return null;
  const res = await updateContentAction(active.id, { collectionId });
  if (!res.isSuccess) return failure(res.message, "Could not move the item");
  announceMoved("content");
  return {
    tone: "ok",
    text: collectionId
      ? `Moved “${active.title}” into ${labelOf(over)}`
      : `Removed “${active.title}” from its section`,
  };
}

async function reparentCollection(
  active: CollectionDrag,
  parentId: string | null
): Promise<DndStatus | null> {
  if (parentId === active.parentId) return null;
  const res = await updateCollectionAction(active.id, { parentId });
  if (!res.isSuccess) return failure(res.message, "Could not move the section");
  announceMoved("collection");
  return {
    tone: "ok",
    text: parentId ? `Moved “${active.name}”` : `Moved “${active.name}” to the top level`,
  };
}

async function moveWithinSiblings(active: CollectionDrag, toIndex: number): Promise<DndStatus | null> {
  if (toIndex === active.groupIndex) return null;
  const res = await moveCollectionAction(active.id, toIndex);
  if (!res.isSuccess) return failure(res.message, "Could not reorder the sections");
  announceMoved("collection");
  return { tone: "ok", text: `Reordered “${active.name}”` };
}

/** Run the drop the user made; returns the status line to show (or nothing). */
async function executeDrop(active: DragPayload, over: TargetPayload): Promise<DndStatus | null> {
  if (active.kind === "content") return dropContent(active, over);
  switch (over.kind) {
    case "into":
      return reparentCollection(active, over.collectionId);
    case "root":
      return reparentCollection(active, null);
    case "collection":
      return moveWithinSiblings(active, over.groupIndex);
  }
}

const STATUS_TTL_MS = 4000;

/** Screen-reader narration in terms of titles and section names, not ids. */
const announcements: Announcements = {
  onDragStart({ active }) {
    return `Picked up ${labelOf(active.data.current as DragPayload | undefined)}.`;
  },
  onDragOver({ active, over }) {
    const what = labelOf(active.data.current as DragPayload | undefined);
    return over
      ? `${what} is over ${labelOf(over.data.current as TargetPayload | undefined)}.`
      : `${what} is no longer over a target.`;
  },
  onDragEnd({ active, over }) {
    const what = labelOf(active.data.current as DragPayload | undefined);
    return over
      ? `Dropped ${what} on ${labelOf(over.data.current as TargetPayload | undefined)}.`
      : `Dropped ${what}; nothing changed.`;
  },
  onDragCancel({ active }) {
    return `Cancelled moving ${labelOf(active.data.current as DragPayload | undefined)}.`;
  },
};

const screenReaderInstructions = {
  draggable:
    "To pick up an item, press space or enter. Use the arrow keys to move it over a section or heading, then press space or enter again to drop it, or escape to cancel.",
};

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
      const over = event.over?.data.current as TargetPayload | undefined;
      setActive(null);
      if (!payload || !over) return;
      void executeDrop(payload, over)
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

  const value = useMemo(() => ({ status }), [status]);

  return (
    <AtriumDndContext.Provider value={value}>
      <DndContext
        sensors={sensors}
        collisionDetection={atriumCollision}
        accessibility={{ announcements, screenReaderInstructions }}
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
