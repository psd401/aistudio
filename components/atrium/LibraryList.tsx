"use client";

/**
 * Atrium LibraryList — the Meridian content card grid (Epic #1059 redesign,
 * slice B; originally Issue #1054, §21).
 *
 * Presentation only: renders the already permission-filtered list its parent
 * (`LibraryView`) loaded via `listContentAction`. Docs and artifacts render as
 * distinct Meridian cards in a responsive 3-column grid; a dashed
 * "Create with the agent" card is the last cell. Each card links to the editor.
 *
 * Artifact cards show a LIVE, scaled sandbox thumbnail of the actual artifact
 * (slice F: `ArtifactThumbnail`), lazy-loaded via IntersectionObserver and capped
 * to a few concurrent frames; the branded gradient is the pre-load/fallback state
 * (and the whole preview when the sandbox origin is unconfigured). Doc cards show
 * the doc's emoji icon (slice F) when set, else the kind's default icon.
 */

import Link from "next/link";
import { FileText, Loader2, Sparkles, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/atrium/relative-time";
import type { ContentObjectDTO } from "@/lib/content";
import { ArtifactThumbnail } from "./ArtifactThumbnail";

/** Meridian status pill class for a content object's lifecycle status. */
function statusBadge(status: ContentObjectDTO["status"]): {
  cls: string;
  label: string;
} {
  switch (status) {
    case "published":
      return { cls: "mer-badge-published", label: "Published" };
    case "archived":
      return { cls: "mer-badge-draft", label: "Archived" };
    default:
      return { cls: "mer-badge-draft", label: "Draft" };
  }
}

/** The meta line under a card title (author + edited time). */
function cardMeta(it: ContentObjectDTO): string {
  const who = it.createdByActor === "agent" ? "Agent" : "Team";
  const edited = timeAgo(it.updatedAt);
  return edited ? `${who} · edited ${edited}` : who;
}

function DocCard({ it }: { it: ContentObjectDTO }): React.JSX.Element {
  const status = statusBadge(it.status);
  const isAgent = it.createdByActor === "agent";
  return (
    <Link
      href={`/atrium/${it.id}/edit`}
      className={cn("mer-lib-card", isAgent && "mer-card-agent")}
    >
      <div className="mer-lib-card-head">
        <span className="mer-icon-chip" data-emoji={it.icon ? "true" : undefined}>
          {it.icon ? (
            <span className="mer-icon-emoji" aria-hidden="true">
              {it.icon}
            </span>
          ) : (
            <FileText className="h-4 w-4" aria-hidden="true" />
          )}
        </span>
        <span className={cn("mer-badge", status.cls)}>{status.label}</span>
      </div>
      <p className="mer-lib-card-title">{it.title}</p>
      <p className="mer-lib-card-meta">
        {isAgent && (
          <Sparkles
            className="mer-agent-mark h-3 w-3"
            aria-label="Agent-authored"
          />
        )}
        {cardMeta(it)}
      </p>
      {it.tags.length > 0 && (
        <p className="mer-lib-card-tags">{it.tags.slice(0, 3).join(" · ")}</p>
      )}
    </Link>
  );
}

function ArtifactCard({
  it,
  sandboxSrc,
}: {
  it: ContentObjectDTO;
  sandboxSrc: string | null;
}): React.JSX.Element {
  const isAgent = it.createdByActor === "agent";
  return (
    <Link
      href={`/atrium/${it.id}/edit`}
      className={cn("mer-lib-card mer-lib-card-artifact", isAgent && "mer-card-agent")}
    >
      <ArtifactThumbnail artifactId={it.id} sandboxSrc={sandboxSrc} />
      <p className="mer-lib-card-title">{it.title}</p>
      <div className="mer-lib-card-foot">
        <span className="mer-lib-card-meta">
          {isAgent ? "Agent-maintained" : "Interactive"}
          {it.updatedAt ? ` · ${timeAgo(it.updatedAt)}` : ""}
        </span>
        <span className="mer-lib-card-open">
          Open <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      </div>
    </Link>
  );
}

function CreateCard({ onCreate }: { onCreate: () => void }): React.JSX.Element {
  return (
    <button type="button" onClick={onCreate} className="mer-create-card">
      <Sparkles className="h-5 w-5" aria-hidden="true" />
      <span className="mer-create-card-title">Create with the agent</span>
      <span className="mer-create-card-sub">
        Describe it — the agent drafts a doc or artifact.
      </span>
    </button>
  );
}

interface LibraryListProps {
  items: ContentObjectDTO[];
  loading: boolean;
  error: string | null;
  /** Opens the creation flow (the dashed "Create with the agent" card). */
  onCreate: () => void;
  /**
   * The cross-origin sandbox render URL (resolved server-side), threaded to each
   * artifact card's live thumbnail. `null` when the sandbox origin is unconfigured
   * → cards keep the gradient placeholder.
   */
  sandboxSrc: string | null;
}

export function LibraryList({
  items,
  loading,
  error,
  onCreate,
  sandboxSrc,
}: LibraryListProps): React.JSX.Element {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-[color:var(--mer-ink-muted)]">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading content…
      </div>
    );
  }
  if (error) {
    return (
      <p className="py-10 text-sm text-destructive" role="alert">
        {error}
      </p>
    );
  }

  return (
    <div className="mer-card-grid">
      {items.map((it) =>
        it.kind === "artifact" ? (
          <ArtifactCard key={it.id} it={it} sandboxSrc={sandboxSrc} />
        ) : (
          <DocCard key={it.id} it={it} />
        )
      )}
      <CreateCard onCreate={onCreate} />
    </div>
  );
}
