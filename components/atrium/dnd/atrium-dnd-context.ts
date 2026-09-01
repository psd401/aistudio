"use client";

/**
 * Atrium drag-and-drop — the shared vocabulary (see `atrium-dnd.tsx` for the
 * provider that performs the moves).
 *
 * Deliberately a leaf module: the tree rows and library cards import THIS to
 * register targets and read drag state, while the provider alone imports the
 * server actions. Keeping the actions out of here is what lets a jsdom unit
 * test render `CollectionTree` without dragging the content service (and its
 * pure-ESM markdown pipeline) into the test.
 */

import { createContext, useContext } from "react";

/** What a draggable carries. */
export type DragPayload =
  | {
      kind: "content";
      id: string;
      title: string;
      collectionId: string | null;
    }
  | {
      kind: "collection";
      id: string;
      name: string;
      parentId: string | null;
      scope: "district" | "private";
      /** The full sibling group (including this id), in tree order. */
      siblingIds: string[];
      /** Every collection nested under this one — never a valid drop target. */
      descendantIds: string[];
    };

/** What a droppable target carries. */
export type DropPayload =
  | {
      kind: "into";
      collectionId: string;
      scope: "district" | "private";
      childCount: number;
    }
  | { kind: "root"; scope: "district" | "private" };

/** Droppable id for "put it inside this section". */
export const intoId = (collectionId: string): string => `into:${collectionId}`;
/** Droppable id for a group heading: "move to the top level" / "un-file". */
export const rootId = (scope: "district" | "private"): string => `root:${scope}`;
/** Draggable id for a library card. */
export const contentDragId = (objectId: string): string => `content:${objectId}`;

export interface DndStatus {
  tone: "ok" | "error";
  text: string;
}

export interface AtriumDndValue {
  /** The payload being dragged, or null when idle. Rows use it to light up. */
  active: DragPayload | null;
  /** The outcome of the last drop, or null. Cleared by the provider after a while. */
  status: DndStatus | null;
}

export const AtriumDndContext = createContext<AtriumDndValue>({
  active: null,
  status: null,
});

/** Drag state for targets and status lines. Inert (idle) outside the provider. */
export function useAtriumDnd(): AtriumDndValue {
  return useContext(AtriumDndContext);
}
