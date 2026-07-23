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
import type { VisibilityLevel } from "@/lib/content/types";
import type { EmbeddingDocument } from "@/lib/content/embed-backlinks";
import { ArtifactAskAgentCard } from "./ArtifactAskAgentCard";

/** Human-readable visibility labels for the ABOUT card. */
const VISIBILITY_LABELS: Record<VisibilityLevel, string> = {
  private: "Private",
  group: "Shared (group)",
  internal: "Internal",
  public: "Public",
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
  visibilityLevel: VisibilityLevel;
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
  visibilityLevel,
  backlinks,
}: ArtifactMetaRailProps): React.JSX.Element {
  return (
    <aside className="mer-artifact-rail" data-testid="artifact-meta-rail">
      {/* ABOUT */}
      <div className="mer-artifact-rail-card">
        <div className="mer-artifact-rail-label">About</div>
        <p className="mer-artifact-about-lead">
          {agentMaintained ? (
            <>
              <span className="mer-agent-mark" aria-hidden="true">
                ✦
              </span>{" "}
              Agent-maintained · auto-refreshes
            </>
          ) : (
            "Human-authored"
          )}
        </p>
        <AboutRow label="Source" value={agentMaintained ? "Agent" : "Human"} />
        <AboutRow label="Updated" value={formatUpdated(updatedAt)} />
        <AboutRow label="Version" value={versionNumber != null ? `v${versionNumber}` : "—"} />
        <AboutRow label="Visibility" value={VISIBILITY_LABELS[visibilityLevel]} />
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
