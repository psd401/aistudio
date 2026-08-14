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
  Maximize2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { timeAgo } from "@/lib/atrium/relative-time";
import type { ContentObjectDTO } from "@/lib/content";
import { ArtifactThumbnail } from "./ArtifactThumbnail";
import { TagPills } from "./TagPills";
import { FavoriteStar } from "./FavoriteStar";

/** Meridian status pill class for a content object's lifecycle status. */
function statusBadge(
  status: ContentObjectDTO["status"],
  /**
   * A publish request for this object is sitting in the approval queue. It
   * OVERRIDES the lifecycle label because it is the more actionable fact: the
   * object is still technically a draft, but nobody should keep editing it or
   * wonder why it has not gone live — it is waiting on a person.
   */
  pendingReview = false
): {
  cls: string;
  label: string;
} {
  if (pendingReview && status !== "archived") {
    return { cls: "mer-badge-review", label: "In review" };
  }
  switch (status) {
    case "published":
      return { cls: "mer-badge-published", label: "Published" };
    // Archived has its OWN pill now. It used to borrow the draft style, so the
    // two states that behave most differently — one still being worked on, one
    // deliberately put away — were the same grey and could only be told apart
    // by reading the word.
    case "archived":
      return { cls: "mer-badge-archived", label: "Archived" };
    default:
      return { cls: "mer-badge-draft", label: "Draft" };
  }
}

/**
 * Where a card click goes.
 *
 * PUBLISHED content opens its READER (`/c/[slug]`), not the editor. Most people
 * in the district are readers, and dropping every one of them into an editing
 * surface — cursor in the title, toolbar overhead, an accidental keystroke away
 * from changing a published page — was the single most disorienting thing about
 * the library. The reader has an Edit button for the people who need it.
 *
 * DRAFTS still open the editor: an unfinished page has nothing to read, and the
 * person looking at a draft is almost always the person writing it. Archived
 * content also opens the editor, which is where restore/delete live.
 */
function cardHref(it: ContentObjectDTO): string {
  return it.status === "published" ? `/c/${it.slug}` : `/atrium/${it.id}/edit`;
}

/** The meta line under a card title (author + edited time). */
function cardMeta(it: ContentObjectDTO): string {
  const who = it.createdByActor === "agent" ? "Agent" : "Team";
  const edited = timeAgo(it.updatedAt);
  return edited ? `${who} · edited ${edited}` : who;
}

/**
 * The audience line on a card: who, roughly, can see this.
 *
 * The catalogue showed lifecycle (draft/published) but never AUDIENCE, so
 * "which of these is actually shared, and how widely?" — the question that
 * matters most when auditing a district-wide library — could only be answered
 * by opening each item's Share dialog one at a time.
 *
 * A COUNT, never names. The grant roster is editor-only (see
 * `getVisibilityAction`); printing it on a card would show every grantee the
 * whole roster. "Shared · 3" answers the question without identifying anyone,
 * and only reaches viewers who can already see the object.
 */
function AudienceLabel({ it }: { it: ContentObjectDTO }): React.JSX.Element | null {
  const label = ((): string | null => {
    switch (it.visibilityLevel) {
      case "public":
        return "Public";
      case "internal":
        return "All staff";
      case "group":
        // A group-level object with zero grants is reachable by nobody but its
        // owner — a real and confusing state worth naming rather than
        // rendering as a bare "Shared · 0".
        return it.grantCount > 0
          ? `Shared · ${it.grantCount}`
          : "Shared with nobody yet";
      case "private":
        return "Private";
      default:
        return null;
    }
  })();
  if (!label) return null;
  return (
    <p className="mer-lib-card-audience" data-testid="card-audience">
      {label}
    </p>
  );
}

/**
 * One-click full screen for an artifact card.
 *
 * Full screen already existed at `/atrium/[id]/view` but was linked from
 * exactly one place: the authoring topbar. Reaching it from the library meant
 * opening the artifact, clicking Edit, then "Open full screen" — three steps
 * through an EDITING surface to do the most common read-only thing anyone does
 * with an artifact.
 *
 * A SIBLING of the card's `<Link>`, never a descendant: an anchor inside an
 * anchor is invalid HTML, and the click would also trigger the card's own
 * navigation. Same rule the selection checkbox and favourite star follow.
 *
 * Deliberately not `target="_blank"`: the authoring topbar opens a new tab
 * because you are working in the editor and want to keep it, but from the
 * library this is just "look at this thing", and back should return to the
 * grid.
 */
function FullScreenLink({ it }: { it: ContentObjectDTO }): React.JSX.Element {
  return (
    <Link
      href={`/atrium/${it.id}/view`}
      className="mer-lib-card-fullscreen"
      aria-label={`Open ${it.title} full screen`}
      title="Open full screen"
      data-testid={`card-fullscreen-${it.id}`}
    >
      <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
    </Link>
  );
}

function DocCard({ it }: { it: ContentObjectDTO }): React.JSX.Element {
  const status = statusBadge(it.status, it.pendingReview);
  const isAgent = it.createdByActor === "agent";
  const isArchived = it.status === "archived";
  return (
    <Link
      href={cardHref(it)}
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
      {/* The head version's summary. Doc cards were a title and a timestamp in
          a card sized for a thumbnail, so most of one was empty — and two docs
          with similar titles were indistinguishable without opening both. */}
      {it.summary && <p className="mer-lib-card-excerpt">{it.summary}</p>}
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
      <AudienceLabel it={it} />
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
  const status = statusBadge(it.status, it.pendingReview);
  return (
    <Link
      href={cardHref(it)}
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
        {/*
          Artifact cards carried NO lifecycle pill — only an Archived overlay —
          so a published artifact and an unpublished draft were
          indistinguishable in the grid while doc cards showed the difference
          plainly. Same badge vocabulary as `DocCard`, positioned as an overlay
          because the thumbnail occupies the card's head slot.
        */}
        <span
          className={cn("mer-badge", status.cls, "mer-artifact-archived-badge")}
        >
          {status.label}
        </span>
      </div>
      <p className="mer-lib-card-title">{it.title}</p>
      {it.ownerName && (
        <p className="mer-lib-card-owner" data-testid="card-owner">
          {it.ownerName}
        </p>
      )}
      <AudienceLabel it={it} />
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
  onFavoriteChange,
  children,
}: {
  it: ContentObjectDTO;
  selected: boolean;
  onToggle: (id: string) => void;
  onFavoriteChange?: (id: string, isFavorite: boolean) => void;
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
      {/* Same sibling-of-the-link rule as the checkbox above. */}
      <FavoriteStar
        objectId={it.id}
        title={it.title}
        initial={it.isFavorite}
        onChange={onFavoriteChange}
      />
      {it.kind === "artifact" && <FullScreenLink it={it} />}
      {children}
    </div>
  );
}

/**
 * One content card by kind, with no selection chrome — the shape the library
 * HOME bands render (they are read surfaces; bulk actions live in the full
 * grid). Exported so the bands do not reimplement card markup and drift from it.
 */
export function ContentCard({
  it,
  sandboxSrc,
  onFavoriteChange,
}: {
  it: ContentObjectDTO;
  sandboxSrc: string | null;
  onFavoriteChange?: (id: string, isFavorite: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="mer-lib-card-wrap" data-testid="library-card-wrap">
      <FavoriteStar
        objectId={it.id}
        title={it.title}
        initial={it.isFavorite}
        onChange={onFavoriteChange}
      />
      {it.kind === "artifact" ? (
        <>
          <FullScreenLink it={it} />
          <ArtifactCard it={it} sandboxSrc={sandboxSrc} />
        </>
      ) : (
        <DocCard it={it} />
      )}
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
      <span className="mer-create-card-title">New interactive page</span>
      <span className="mer-create-card-sub">
        Describe it and the agent builds it — or start from a blank page.
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
      <div
        className="flex items-center gap-2 py-10 text-sm text-[color:var(--mer-ink-muted)]"
        role="status"
      >
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
