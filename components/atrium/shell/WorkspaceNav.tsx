"use client";

/**
 * Atrium Meridian workspace nav column (Epic #1059 redesign, slice A)
 *
 * The 236px library-scoped column: the section tree + the AGENT ACTIVITY panel.
 * Isolated from the shell so its `useSearchParams` read (section selection is
 * URL-driven, `?collection=<id>`) sits behind its own Suspense boundary without
 * pushing the rail or page children into that boundary.
 */

import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CollectionTree } from "@/components/atrium/CollectionTree";
import type { CollectionTreeNode } from "@/lib/content";
import { AgentActivityFeed } from "./AgentActivityFeed";

export function WorkspaceNav(): React.JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedCollectionId = searchParams.get("collection");

  const onSelectCollection = useCallback(
    (node: CollectionTreeNode | null) => {
      // A section now has a real page of its own (hero, subsections, contents)
      // instead of being a query param that re-filtered the flat grid.
      if (node) {
        router.push(`/atrium/s/${node.slug}`);
        return;
      }
      // "All content" clears any section scoping and returns to the library.
      const params = new URLSearchParams(searchParams);
      params.delete("collection");
      const qs = params.toString();
      router.push(qs ? `/atrium?${qs}` : "/atrium");
    },
    [router, searchParams]
  );

  return (
    <aside className="mer-navcol" aria-label="Workspace">
      <p className="mer-navcol-label">Workspace</p>
      <CollectionTree
        selectedCollectionId={selectedCollectionId}
        onSelect={onSelectCollection}
      />
      <div className="mer-navcol-divider" />
      <p className="mer-navcol-label">Agent activity</p>
      <AgentActivityFeed />
    </aside>
  );
}
