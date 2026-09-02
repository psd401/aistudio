"use client";

/**
 * Atrium drag-and-drop — the shared vocabulary (see `atrium-dnd.tsx` for the
 * provider that performs the moves).
 *
 * Deliberately a leaf module: the tree rows and library cards import THIS to
 * register targets and read the outcome line, while the provider alone
 * imports the server actions. Keeping the actions out of here is what lets a
 * jsdom unit test render `CollectionTree` without dragging the content service
 * (and its pure-ESM markdown pipeline) into the test.
 *
 * Every draggable and droppable carries a typed payload with a `kind`
 * discriminator; the provider dispatches on that, never on the id strings
 * (which only need to be unique).
 */

import { createContext, useContext } from "react";

/** What a draggable carries. A sortable tree row is also a drop target. */
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
      ownerUserId: number | null;
      scope: "district" | "private";
      /** Index among its live siblings (same parent AND owner) as displayed. */
      groupIndex: number;
      /** Every collection nested under this one — never a valid drop target. */
      descendantIds: string[];
    };

/** What a pure drop target carries. */
export type DropPayload =
  | {
      kind: "into";
      collectionId: string;
      name: string;
      parentId: string | null;
      ownerUserId: number | null;
      scope: "district" | "private";
    }
  | { kind: "root"; scope: "district" | "private" };

/** Anything a drag can land on: a pure target, or a sibling row. */
export type TargetPayload = DropPayload | Extract<DragPayload, { kind: "collection" }>;

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
  /** The outcome of the last drop, or null. Cleared by the provider after a while. */
  status: DndStatus | null;
}

export const AtriumDndContext = createContext<AtriumDndValue>({ status: null });

/** The last drop's outcome, for the tree's status line. Inert outside the provider. */
export function useAtriumDnd(): AtriumDndValue {
  return useContext(AtriumDndContext);
}
