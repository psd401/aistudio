"use client";

/**
 * The way out of the chrome-free artifact viewport (#1793).
 *
 * `/atrium/[id]/view` renders a fixed, full-viewport overlay precisely so that
 * no app chrome shows — which also means it has no title, no close control and
 * no link back. Everyone who lands here needs a way out, not just editors:
 * `LibraryList`'s full-screen link and the reader's own full-screen link both
 * navigate here in the SAME tab, and a plain viewer arriving that way is just
 * as stranded as an author.
 *
 * So the control is always rendered, and only its destination depends on who is
 * looking:
 *  - an editor gets a real link to the editor for this object;
 *  - everyone else gets history-back, because where they came from (a library
 *    grid, a `/c/` reader, a collection) is not something this route can know.
 *    When there is no history to go back to — the viewport was opened in a new
 *    tab, or pasted into a fresh one — it falls back to the Atrium library
 *    rather than doing nothing.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback } from "react";
import { ArrowLeft } from "lucide-react";

const CONTROL_CLASS =
  "absolute left-4 top-4 z-10 inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-white/90 px-3 py-1.5 text-sm font-medium text-neutral-800 shadow-sm backdrop-blur transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-800";

export interface ArtifactViewportBackProps {
  /** `/atrium/<id>/edit` when the viewer may edit; omitted otherwise. */
  editHref?: string;
}

export function ArtifactViewportBack({ editHref }: ArtifactViewportBackProps) {
  const router = useRouter();

  const goBack = useCallback(() => {
    // `history.length` is 1 only for a tab whose first entry is this page, so
    // this distinguishes "arrived by a link" from "opened cold".
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
      return;
    }
    router.push("/atrium");
  }, [router]);

  if (editHref) {
    return (
      <Link
        href={editHref}
        data-testid="artifact-viewport-back"
        className={CONTROL_CLASS}
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to editor
      </Link>
    );
  }

  return (
    <button
      type="button"
      onClick={goBack}
      data-testid="artifact-viewport-back"
      className={CONTROL_CLASS}
    >
      <ArrowLeft className="h-4 w-4" aria-hidden="true" />
      Back
    </button>
  );
}
