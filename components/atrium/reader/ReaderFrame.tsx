/**
 * Atrium reader frame — the Meridian published-page shell (Epic #1059, slice E)
 *
 * The shared chrome for the internal (`/c/[slug]`) AND public (`/p/[slug]`)
 * readers (screen 2c): the branded intranet top nav, a left "ON THIS PAGE" TOC rail
 * + "View only" notice, and the reading sheet (title, "Published … · collection"
 * meta + "UP TO DATE" pill, body, provenance footer).
 *
 * This component OWNS the `.atrium-meridian` token scope + Schibsted Grotesk font
 * variable, so wrapping a reader's body in `<ReaderFrame>` is all a page needs to
 * pick up the Meridian tokens (the readers live outside the `/atrium` layout that
 * scopes them elsewhere). It is presentational — every decision (can this viewer
 * edit? which nav variant? which headings?) is made by the page and passed in:
 *  - `editHref === null` ⇒ view-only: renders the "👁 View only" notice, no Edit link.
 *  - `authenticated` picks the nav variant (avatar only when true; the public reader
 *    passes false so no session is ever read).
 *  - `headings` drives the TOC ([] for artifact readers ⇒ no TOC).
 */

import Link from "next/link";
import { fontMeridian } from "@/lib/atrium/meridian-fonts";
import type { DocumentHeading } from "@/lib/content/render/headings";
import { coverGradientClass } from "@/lib/atrium/cover";
import { AtriumReaderNav } from "./AtriumReaderNav";
import { ReaderToc } from "./ReaderToc";
// The readers live OUTSIDE the `/atrium` layout that scopes Meridian elsewhere, so
// the reader frame must pull the token layer + `.mer-reader-*` chrome itself (the
// pages already import the shared `atrium-content.css` body sink). Scoped under
// `.atrium-meridian` — no leakage to the rest of the reader routes.
import "@/styles/atrium-meridian.css";

export interface ReaderFrameProps {
  /** The document/artifact title (rendered as the sheet heading). */
  title: string;
  /** True on the internal reader (nav renders the avatar). */
  authenticated: boolean;
  /** The `/atrium/[id]/edit` link, or null when the viewer may not edit (view-only). */
  editHref: string | null;
  /** Where the editors-only comment chip links (the editor), or null. */
  commentHref: string | null;
  /** Unresolved root-comment threads; the chip is hidden when 0 or non-editor. */
  commentCount: number;
  /** When the published version went live at this destination (meta line). */
  publishedAt: Date | string | null;
  /** The object's collection name for the meta line, or null. */
  collectionName: string | null;
  /** Rendered-document headings for the TOC ([] ⇒ no TOC, e.g. artifact readers). */
  headings: DocumentHeading[];
  /** Cover-gradient preset key (slice F), or null for no cover band. */
  coverGradient?: string | null;
  /** Doc emoji icon (slice F), shown on the cover tile, or null. */
  icon?: string | null;
  /** The reader body (document parts or the artifact sandbox). */
  children: React.ReactNode;
  /** The provenance footer element (kept at the bottom of the sheet). */
  footer: React.ReactNode;
  /**
   * Full-bleed variant (#1052): render the body edge-to-edge under a slim header
   * bar instead of inside the 720px reading sheet. The artifact readers pass this
   * so an interactive artifact fills the viewport; documents keep the sheet (the
   * default). It drops the TOC rail (artifacts have no headings anyway) and moves
   * the title/meta/edit chrome into a top bar above the full-width stage.
   */
  fullBleed?: boolean;
}

/** Format a publish timestamp as e.g. "Oct 1, 2026", or null when absent/invalid. */
function formatPublished(publishedAt: Date | string | null): string | null {
  if (!publishedAt) return null;
  const d = publishedAt instanceof Date ? publishedAt : new Date(publishedAt);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * The read-only cover band + emoji tile (slice F). Renders the band when a gradient
 * was chosen OR an icon is set (an icon needs the band as its backdrop; falls back
 * to the default gradient in that case). Read-only — no "Change cover" pill.
 */
function ReaderCover({
  coverGradient,
  icon,
}: {
  coverGradient?: string | null;
  icon?: string | null;
}): React.JSX.Element | null {
  const trimmedIcon = icon?.trim() || null;
  const gradClass = coverGradientClass(coverGradient);
  if (!gradClass && !trimmedIcon) return null;
  return (
    <>
      <div
        className={`mer-cover ${gradClass ?? "mer-cover--default"}`}
        data-testid="reader-cover"
        aria-hidden="true"
      />
      {trimmedIcon && (
        <div className="mer-cover-icon" data-testid="reader-icon" aria-hidden="true">
          {trimmedIcon}
        </div>
      )}
    </>
  );
}

export function ReaderFrame({
  title,
  authenticated,
  editHref,
  commentHref,
  commentCount,
  publishedAt,
  collectionName,
  headings,
  coverGradient,
  icon,
  children,
  footer,
  fullBleed = false,
}: ReaderFrameProps): React.JSX.Element {
  const viewOnly = editHref === null;
  const publishedLabel = formatPublished(publishedAt);
  const metaBits = [
    publishedLabel ? `Published ${publishedLabel}` : null,
    collectionName?.trim() || null,
  ].filter((bit): bit is string => bit != null);
  // The rail carries the TOC and/or the view-only notice; render it only when it
  // would have content (an editor viewing a heading-less doc gets no empty rail).
  const showRail = headings.length > 0 || viewOnly;

  // Full-bleed variant: a slim header bar over an edge-to-edge, viewport-filling
  // stage (used by the artifact readers). Keeps the same nav + the reader testids
  // (reader-view-only / reader-edit-link / reader-comment-chip / reader-uptodate).
  if (fullBleed) {
    return (
      <div
        className={`atrium-meridian ${fontMeridian.variable} mer-reader mer-reader--artifact`}
      >
        <AtriumReaderNav authenticated={authenticated} />
        <div className="mer-reader-artifact-bar">
          <div>
            <h1 className="mer-reader-artifact-title">{title}</h1>
            <div className="mer-reader-artifact-meta">
              {metaBits.length > 0 && <span>{metaBits.join(" · ")}</span>}
              <span
                className="mer-reader-pill-uptodate"
                data-testid="reader-uptodate"
              >
                UP TO DATE
              </span>
            </div>
          </div>
          <div className="mer-reader-artifact-bar-actions">
            {viewOnly ? (
              <span
                className="mer-reader-viewonly-inline"
                data-testid="reader-view-only"
              >
                👁 View only
              </span>
            ) : (
              <>
                {commentHref && commentCount > 0 && (
                  <Link
                    href={commentHref}
                    className="mer-reader-comment-chip"
                    data-testid="reader-comment-chip"
                  >
                    {commentCount} comment{commentCount === 1 ? "" : "s"}
                  </Link>
                )}
                {editHref && (
                  <Link
                    href={editHref}
                    className="mer-reader-edit"
                    data-testid="reader-edit-link"
                  >
                    Edit
                  </Link>
                )}
              </>
            )}
          </div>
        </div>
        <div className="mer-reader-artifact-stage">{children}</div>
        <div className="mer-reader-artifact-foot">{footer}</div>
      </div>
    );
  }

  return (
    <div className={`atrium-meridian ${fontMeridian.variable} mer-reader`}>
      <AtriumReaderNav authenticated={authenticated} />

      <div className="mer-reader-body">
        {showRail && (
          <aside className="mer-reader-rail" aria-label="Page contents">
            <ReaderToc headings={headings} />
            {viewOnly && (
              <div className="mer-reader-viewonly" data-testid="reader-view-only">
                <span className="mer-reader-viewonly-strong">👁 View only.</span>{" "}
                You can read and search; editing is limited to page owners.
              </div>
            )}
          </aside>
        )}

        <div className="mer-reader-sheet-wrap">
          <div className="mer-reader-sheet">
            <ReaderCover coverGradient={coverGradient} icon={icon} />
            <div className="mer-reader-head">
              <h1 className="mer-reader-title">{title}</h1>
              {editHref && (
                <div className="mer-reader-actions">
                  {commentHref && commentCount > 0 && (
                    <Link
                      href={commentHref}
                      className="mer-reader-comment-chip"
                      data-testid="reader-comment-chip"
                    >
                      {commentCount} comment{commentCount === 1 ? "" : "s"}
                    </Link>
                  )}
                  <Link
                    href={editHref}
                    className="mer-reader-edit"
                    data-testid="reader-edit-link"
                  >
                    Edit
                  </Link>
                </div>
              )}
            </div>

            <div className="mer-reader-meta">
              {metaBits.length > 0 && <span>{metaBits.join(" · ")}</span>}
              <span
                className="mer-reader-pill-uptodate"
                data-testid="reader-uptodate"
              >
                UP TO DATE
              </span>
            </div>

            {children}
            {footer}
          </div>
        </div>
      </div>
    </div>
  );
}

export default ReaderFrame;
