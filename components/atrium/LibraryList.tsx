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
 * Artifact cards show a branded gradient PREVIEW (not a live sandbox thumbnail):
 * there is no thumbnail pipeline, the cross-origin sandbox origin is not
 * available on every deploy, and fetching each artifact's code per card would be
 * an N-request storm. The gradient + "LIVE ARTIFACT" pill conveys the
 * agent-maintained, always-current nature without that cost; a real cached
 * snapshot is a later enhancement.
 */

import Link from "next/link";
import { FileText, Boxes, Loader2, Sparkles, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/atrium/relative-time";
import type { ContentObjectDTO } from "@/lib/content";

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
        <span className="mer-icon-chip">
          <FileText className="h-4 w-4" aria-hidden="true" />
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

function ArtifactCard({ it }: { it: ContentObjectDTO }): React.JSX.Element {
  const isAgent = it.createdByActor === "agent";
  return (
    <Link
      href={`/atrium/${it.id}/edit`}
      className={cn("mer-lib-card mer-lib-card-artifact", isAgent && "mer-card-agent")}
    >
      <div className="mer-artifact-preview" aria-hidden="true">
        <span className="mer-badge mer-badge-live">● Live artifact</span>
        <Boxes className="mer-artifact-preview-icon h-8 w-8" />
      </div>
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
}

export function LibraryList({
  items,
  loading,
  error,
  onCreate,
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
          <ArtifactCard key={it.id} it={it} />
        ) : (
          <DocCard key={it.id} it={it} />
        )
      )}
      <CreateCard onCreate={onCreate} />
    </div>
  );
}
