"use client";

/**
 * Atrium ReaderCollectionSidebar — the reader's section sidebar (Epic #1059
 * completion)
 *
 * A thin client wrapper mounting the SAME visibility-filtered `CollectionTree`
 * (+ `collectionTreeAction` data source) the LibraryView uses, on the intranet
 * reader (`/c/[slug]`) when the object belongs to a collection. The object's own
 * section renders selected for orientation; choosing any section navigates to
 * the library filtered to it (`/atrium?collection=<id>`, which LibraryView reads
 * on mount), and "All content" goes to the unfiltered library.
 *
 * Presentation only: the tree is permission-pruned server-side, so a reader
 * never sees a section they cannot enter.
 */

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { CollectionTree } from "@/components/atrium/CollectionTree";

export interface ReaderCollectionSidebarProps {
  /** The collection the object being read belongs to (renders selected). */
  collectionId: string;
}

export function ReaderCollectionSidebar({
  collectionId,
}: ReaderCollectionSidebarProps): React.JSX.Element {
  const router = useRouter();

  const handleSelect = useCallback(
    (selected: string | null) => {
      router.push(
        selected
          ? `/atrium?collection=${encodeURIComponent(selected)}`
          : "/atrium"
      );
    },
    [router]
  );

  return (
    <CollectionTree
      selectedCollectionId={collectionId}
      onSelect={handleSelect}
    />
  );
}
