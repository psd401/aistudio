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
import {
  FileText,
  Loader2,
  Sparkles,
  ArrowUpRight,
  Archive,
  SearchX,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/atrium/relative-time";
import type { ContentObjectDTO } from "@/lib/content";
import { ArtifactThumbnail } from "./ArtifactThumbnail";
import { TagPills } from "./TagPills";

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
  const isArchived = it.status === "archived";
  return (
    <Link
      href={`/atrium/${it.id}/edit`}
      className={cn(
        "mer-lib-card",
        isAgent && "mer-card-agent",
        isArchived && "mer-card-archived"
      )}
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
      {it.ownerName && (
        <p className="mer-lib-card-owner" data-testid="card-owner">
          {it.ownerName}
        </p>
      )}
      <TagPills tags={it.tags} />
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
  const isArchived = it.status === "archived";
  return (
    <Link
      href={`/atrium/${it.id}/edit`}
      className={cn(
        "mer-lib-card mer-lib-card-artifact",
        isAgent && "mer-card-agent",
        isArchived && "mer-card-archived"
      )}
    >
      {/* Positioned wrapper so the ARCHIVED pill can overlay the preview's
          top-left corner (the thumbnail itself is aria-hidden and carries the
          top-right "Live artifact" badge — the pill must sit outside it to stay
          in the accessibility tree). */}
      <div className="mer-artifact-preview-wrap">
        <ArtifactThumbnail artifactId={it.id} sandboxSrc={sandboxSrc} />
        {isArchived && (
          <span className="mer-badge mer-badge-draft mer-artifact-archived-badge">
            Archived
          </span>
        )}
      </div>
      <p className="mer-lib-card-title">{it.title}</p>
      {it.ownerName && (
        <p className="mer-lib-card-owner" data-testid="card-owner">
          {it.ownerName}
        </p>
      )}
      <TagPills tags={it.tags} />
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

/**
 * Wraps one card with its selection checkbox (#1336). The checkbox is a SIBLING
 * of the card's `<Link>`, never a descendant: nesting an interactive control
 * inside an anchor is invalid HTML and every click would also navigate. The
 * wrapper is `position: relative` so the checkbox can overlay the card's
 * top-left corner without participating in the card's own layout.
 */
function SelectableCard({
  it,
  selected,
  onToggle,
  children,
}: {
  it: ContentObjectDTO;
  selected: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div
      className="mer-lib-card-wrap"
      data-selected={selected ? "true" : "false"}
      data-testid="library-card-wrap"
    >
      <input
        type="checkbox"
        className="mer-lib-card-check"
        checked={selected}
        onChange={() => onToggle(it.id)}
        aria-label={`Select ${it.title}`}
        data-testid={`select-${it.id}`}
      />
      {children}
    </div>
  );
}

/** The zero-match empty state for an active search/tag filter (#1336). */
function SearchEmpty({
  query,
  /** Which input produced the zero-match, so the recovery hint names it. */
  source = "search",
}: {
  query: string;
  source?: "search" | "tag";
}): React.JSX.Element {
  return (
    <div className="mer-lib-empty" role="status" data-testid="library-search-empty">
      <span className="mer-lib-empty-icon" aria-hidden="true">
        <SearchX className="h-6 w-6" />
      </span>
      <p className="mer-lib-empty-title">No matches for “{query}”</p>
      <p className="mer-lib-empty-sub">
        {source === "tag"
          ? "Nothing in your library carries that tag. Try a different tag, or clear the tag filter to see everything."
          : "Nothing in your library matches that title or tag. Try a shorter term, or clear the search to see everything."}
      </p>
    </div>
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

/** The archived-view empty state ("Nothing archived"). */
function ArchivedEmpty(): React.JSX.Element {
  return (
    <div className="mer-lib-empty" role="status">
      <span className="mer-lib-empty-icon" aria-hidden="true">
        <Archive className="h-6 w-6" />
      </span>
      <p className="mer-lib-empty-title">Nothing archived</p>
      <p className="mer-lib-empty-sub">
        Archived docs and artifacts appear here. Open one to restore it or delete
        it permanently.
      </p>
    </div>
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
  /**
   * The "Archived" filter is active. The archived view is a MANAGEMENT surface:
   * it drops the dashed "Create with the agent" card (you never create archived
   * content) and shows a dedicated "Nothing archived" empty state instead of the
   * create affordance.
   */
  archivedView: boolean;
  /**
   * The ids currently multi-selected for a bulk action (#1336). Owned by
   * `LibraryView`; this component only renders the checkbox state.
   */
  selected: ReadonlySet<string>;
  /** Toggle one id's membership in the selection. */
  onToggleSelect: (id: string) => void;
  /**
   * The active search term, non-empty only when the user is filtering. Drives
   * the zero-match empty state (which must NOT be confused with an empty
   * library — the copy and the missing "create" affordance differ).
   */
  searchTerm: string;
  /**
   * The active tag-chip filter, non-empty only while a tag is applied. A
   * SEPARATE input from `searchTerm` (the free-text box), and it needs the same
   * zero-match empty state: a tag that matches nothing otherwise falls through
   * to the ordinary empty-library grid + create card — exactly the "is my
   * library empty, or did my filter match nothing?" confusion this state exists
   * to remove (#1336).
   */
  tagTerm: string;
}

export function LibraryList({
  items,
  loading,
  error,
  onCreate,
  sandboxSrc,
  archivedView,
  selected,
  onToggleSelect,
  searchTerm,
  tagTerm,
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

  // A filter that matched nothing gets its own empty state — and NO create card,
  // which would otherwise read as "your library is empty" (#1336). Checked
  // before the archived-empty branch so filtering inside Archived also explains
  // itself as a zero-match rather than "nothing archived". The free-text box
  // wins when both are active, since it is the more specific of the two.
  if (items.length === 0) {
    const search = searchTerm.trim();
    if (search.length > 0) return <SearchEmpty query={search} />;
    const tag = tagTerm.trim();
    if (tag.length > 0) return <SearchEmpty query={tag} source="tag" />;
  }

  // Archived view + nothing archived: its own empty state, no create card.
  if (archivedView && items.length === 0) {
    return <ArchivedEmpty />;
  }

  return (
    <div className="mer-card-grid">
      {items.map((it) => (
        <SelectableCard
          key={it.id}
          it={it}
          selected={selected.has(it.id)}
          onToggle={onToggleSelect}
        >
          {it.kind === "artifact" ? (
            <ArtifactCard it={it} sandboxSrc={sandboxSrc} />
          ) : (
            <DocCard it={it} />
          )}
        </SelectableCard>
      ))}
      {/* No "create" affordance in the archived management view. */}
      {!archivedView && <CreateCard onCreate={onCreate} />}
    </div>
  );
}
