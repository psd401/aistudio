/**
 * Shared flattening of the Atrium collection tree into flat select options.
 *
 * Extracted from `components/atrium/ContentSettings.tsx` (#1336) so the library
 * bulk "Move to section" control can reuse the exact same depth-prefixed labels
 * as the editor settings dialog. Both surfaces read the SAME visibility-filtered
 * source (`collectionTreeAction`) — this helper only shapes it for a flat
 * `<Select>`, it applies no authorization of its own.
 */

import type { CollectionTreeNode } from "@/lib/content";

/** One flattened collection option (depth drives the indent prefix). */
export interface CollectionOption {
  id: string;
  label: string;
}

/**
 * Radix Select items cannot carry an empty-string value, so "no section" is a
 * sentinel mapped to `null` at save time. Not a plausible collection UUID.
 */
export const NO_COLLECTION = "__none__";

/** Depth-first flatten of the visibility-filtered tree into select options. */
export function flattenTree(
  nodes: CollectionTreeNode[],
  depth = 0,
  out: CollectionOption[] = []
): CollectionOption[] {
  for (const node of nodes) {
    out.push({ id: node.id, label: `${"— ".repeat(depth)}${node.name}` });
    flattenTree(node.children, depth + 1, out);
  }
  return out;
}
