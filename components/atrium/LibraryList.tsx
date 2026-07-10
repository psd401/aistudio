"use client";

/**
 * Atrium LibraryList — the content rows of the library (Issue #1054, §21).
 *
 * Presentation only: renders the already permission-filtered list its parent
 * (`LibraryView`) loaded via `listContentAction`. Each row links to the editor.
 */

import Link from "next/link";
import { FileText, Boxes, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ContentObjectDTO } from "@/lib/content";

function statusBadgeClass(status: ContentObjectDTO["status"]): string {
  switch (status) {
    case "published":
      return "bg-green-100 text-green-800";
    case "archived":
      return "bg-gray-100 text-gray-600";
    default:
      return "bg-amber-100 text-amber-800";
  }
}

interface LibraryListProps {
  items: ContentObjectDTO[];
  loading: boolean;
  error: string | null;
}

export function LibraryList({
  items,
  loading,
  error,
}: LibraryListProps): React.JSX.Element {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading content…
      </div>
    );
  }
  if (error) {
    return <p className="py-8 text-sm text-destructive">{error}</p>;
  }
  if (items.length === 0) {
    return (
      <p className="py-8 text-sm text-muted-foreground">
        No content found. Create a doc or artifact to get started.
      </p>
    );
  }

  return (
    <ul className="divide-y rounded-md border">
      {items.map((it) => (
        <li key={it.id}>
          <Link
            href={`/atrium/${it.id}/edit`}
            className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50"
          >
            {it.kind === "artifact" ? (
              <Boxes className="h-5 w-5 shrink-0 text-muted-foreground" />
            ) : (
              <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate font-medium">{it.title}</span>
            {it.tags.length > 0 && (
              <span className="hidden truncate text-xs text-muted-foreground sm:inline">
                {it.tags.slice(0, 3).join(" · ")}
              </span>
            )}
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-xs",
                statusBadgeClass(it.status)
              )}
            >
              {it.status}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
