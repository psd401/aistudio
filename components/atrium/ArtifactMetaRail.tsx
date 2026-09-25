/**
 * Atrium artifact viewer metadata rail (Epic #1059 Meridian redesign, slice D)
 *
 * The 300px right rail shown ONLY to users with manage rights (the artifact page
 * gates on `canEdit`; viewers without rights see the canvas full-width). Three
 * cards:
 *  - ABOUT — source / updated / version / visibility (data already on the object +
 *    its current version).
 *  - EMBEDDED IN — the documents that embed this artifact (viewer-filtered
 *    backlinks from `content_embed_links`).
 *  - Ask the agent — the prompt-to-change affordance (client card).
 *
 * Server component (static rail data) composing one interactive client card.
 */

import Link from "next/link";
import {
  isLiveDataObject,
  type ContentDataAccess,
  type VisibilityLevel,
} from "@/lib/content/types";
import type { EmbeddingDocument } from "@/lib/content/embed-backlinks";
import {
  NEXUS_CHAT_AUTHOR_LABEL,
  versionAuthorDescription,
  versionAuthorLabel,
} from "@/lib/content/version-author-label";
import { ArtifactAskAgentCard } from "./ArtifactAskAgentCard";

/** Human-readable visibility labels for the ABOUT card. */
const VISIBILITY_LABELS: Record<VisibilityLevel, string> = {
  private: "Private",
  group: "Shared (group)",
  internal: "Internal",
  public: "Public",
};

/**
 * What the artifact's data-bridge mode means, in the rail's voice (#1790).
 *
 * Before this row the About card described a `query`-mode dashboard as
 * "Human-authored / Source: Human" and said nothing at all about it reading live
 * district data — the single most important fact about the page, visible only by
 * opening the Content settings dialog. "(as viewer)" is the part that matters:
 * what a reader sees is scoped to THEIR permissions, not the author's.
 */
const DATA_ACCESS_LABELS: Record<ContentDataAccess, string> = {
  query: "Live PSD data (as viewer)",
  records: "Saves reader entries",
  none: "None",
};

/** Format an ISO timestamp as a short date, or a dash when absent. */
function formatUpdated(updatedAt: string | null): string {
  if (!updatedAt) return "—";
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export interface ArtifactMetaRailProps {
  artifactId: string;
  /** Whether the artifact is agent-maintained (createdByActor === "agent"). */
  agentMaintained: boolean;
  updatedAt: string | null;
  /** The current head version number, or null when none exists yet. */
  versionNumber: number | null;
  /**
   * The head version's authoring surface (#1791 finding 6), e.g. "nexus-chat",
   * or null when a person authored it directly. Without it this card called a
   * version the chat MODEL wrote "Human-authored", because the chat tools run
   * under the user's own requester.
   */
  headAuthorLabel?: string | null;
  /**
   * The head version's actor. The About card describes the CURRENT version, so
   * this wins over the creator-level `agentMaintained` whenever a head exists —
   * a human-created artifact later rewritten by an agent (or the reverse) must
   * not be described by who created it.
   */
  headAuthorActor?: "human" | "agent" | null;
  visibilityLevel: VisibilityLevel;
  /**
   * The artifact's sandbox data-bridge mode (#1790). Surfaced here because the
   * rail is where an author looks to find out what the page IS, and "it reads
   * live district data" was reachable only from the Content settings dialog.
   */
  dataAccess: ContentDataAccess;
  /** Viewer-visible documents that embed this artifact. */
  backlinks: EmbeddingDocument[];
}

/** One "label: value" row in the ABOUT card. */
function AboutRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="mer-artifact-about-row">
      <span className="mer-artifact-about-key">{label}</span>
      <span className="mer-artifact-about-val">{value}</span>
    </div>
  );
}

export function ArtifactMetaRail({
  artifactId,
  agentMaintained,
  updatedAt,
  versionNumber,
  headAuthorLabel = null,
  headAuthorActor = null,
  visibilityLevel,
  dataAccess,
  backlinks,
}: ArtifactMetaRailProps): React.JSX.Element {
  // #1791: the object-level `agentMaintained` flag and the head version's
  // authoring surface are different facts, and the shared helper resolves them
  // into one phrase so this card and the version lists never disagree.
  const authorship = {
    authorActor:
      headAuthorActor ?? (agentMaintained ? ("agent" as const) : ("human" as const)),
    authorLabel: headAuthorLabel,
  };
  const agentWrote =
    authorship.authorActor === "agent" ||
    authorship.authorLabel === NEXUS_CHAT_AUTHOR_LABEL;
  return (
    <aside className="mer-artifact-rail" data-testid="artifact-meta-rail">
      {/* ABOUT */}
      <div className="mer-artifact-rail-card">
        <div className="mer-artifact-rail-label">About</div>
        <p className="mer-artifact-about-lead">
          {agentWrote ? (
            <>
              <span className="mer-agent-mark" aria-hidden="true">
                ✦
              </span>{" "}
              {versionAuthorDescription(authorship)}
            </>
          ) : (
            versionAuthorDescription(authorship)
          )}
        </p>
        <AboutRow label="Source" value={versionAuthorLabel(authorship)} />
        <AboutRow label="Updated" value={formatUpdated(updatedAt)} />
        <AboutRow label="Version" value={versionNumber != null ? `v${versionNumber}` : "—"} />
        <AboutRow label="Visibility" value={VISIBILITY_LABELS[visibilityLevel]} />
        <AboutRow label="Data" value={DATA_ACCESS_LABELS[dataAccess]} />
        {isLiveDataObject(dataAccess) && (
          <p className="mer-artifact-about-note" data-testid="artifact-data-note">
            Every reader sees only the data their own district permissions allow.
            Change this in Content settings.
          </p>
        )}
      </div>

      {/* EMBEDDED IN */}
      <div className="mer-artifact-rail-card">
        <div className="mer-artifact-rail-label">Embedded in</div>
        {backlinks.length === 0 ? (
          <p className="mer-artifact-rail-empty">Not embedded in any documents yet.</p>
        ) : (
          <ul className="mer-artifact-backlinks">
            {backlinks.map((doc) => (
              <li key={doc.id}>
                <Link
                  href={`/atrium/${doc.id}/edit`}
                  className="mer-artifact-backlink"
                  data-testid="artifact-backlink"
                >
                  {doc.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ASK THE AGENT */}
      <ArtifactAskAgentCard artifactId={artifactId} />
    </aside>
  );
}

export default ArtifactMetaRail;
