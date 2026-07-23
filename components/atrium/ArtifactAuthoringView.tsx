/**
 * Atrium artifact authoring view (Epic #1059 Meridian redesign, slice D)
 *
 * The Meridian chrome for the artifact viewer/authoring surface: a topbar
 * (breadcrumb · title · "● LIVE ARTIFACT" pill · Embed-in-doc · Share · primary
 * "Open full screen ↗") over the canvas, plus — ONLY for users with manage rights
 * (`canEdit`) — the 300px metadata rail (ABOUT / EMBEDDED IN / Ask-the-agent).
 * Viewers without manage rights see the canvas full-width.
 *
 * Server component: it resolves the current head (for the rail's version number)
 * and the viewer-filtered embed backlinks, then composes the chrome around the
 * client `<ArtifactCanvas>`. Extracted from the authoring page so the page's route
 * handler stays lean (max-complexity lint).
 */

import Link from "next/link";
import type { ContentObjectDTO, Requester } from "@/lib/content/types";
import { versionService } from "@/lib/content/version-service";
import { listEmbeddingDocuments } from "@/lib/content/embed-backlinks";
import { getArtifactSandboxRenderUrl } from "@/lib/content/artifact-sandbox-config";
import { ArtifactCanvas } from "./ArtifactCanvas";
import { ArtifactTopbarActions } from "./ArtifactTopbarActions";
import { ArtifactMetaRail } from "./ArtifactMetaRail";
import { ContentSettings } from "./ContentSettings";
import { VisibilityChip } from "./VisibilityChip";

export interface ArtifactAuthoringViewProps {
  obj: ContentObjectDTO;
  /** The resolved session principal (rail backlinks are filtered to its view). */
  req: Requester;
  /** Whether the viewer may manage the artifact (gates the rail + settings). */
  userCanEdit: boolean;
  /** The collection name for the breadcrumb, or null when uncollected. */
  collectionName: string | null;
}

export async function ArtifactAuthoringView({
  obj,
  req,
  userCanEdit,
  collectionName,
}: ArtifactAuthoringViewProps): Promise<React.JSX.Element> {
  // Reader URL for the current visibility: a public artifact's full-screen / share
  // target is the anonymous /p/ reader; everything else the internal /c/.
  const readerHref =
    obj.visibilityLevel === "public" ? `/p/${obj.slug}` : `/c/${obj.slug}`;

  // Rail data (manage-rights only): the current head backs the version number; the
  // backlinks are viewer-filtered documents that embed this artifact.
  const [currentVersion, backlinks] = userCanEdit
    ? await Promise.all([
        versionService.current(obj.id),
        listEmbeddingDocuments(req, obj.id),
      ])
    : [null, []];

  return (
    <div className="mer-artifact">
      <div className="mer-editor-topbar">
        <nav className="mer-breadcrumb" aria-label="Breadcrumb">
          <Link href="/atrium" className="mer-breadcrumb-crumb">
            Library
          </Link>
          {collectionName && obj.collectionId && (
            <span className="mer-breadcrumb-crumb-group">
              <span className="mer-breadcrumb-sep" aria-hidden="true">
                /
              </span>{" "}
              <Link
                href={`/atrium?collection=${obj.collectionId}`}
                className="mer-breadcrumb-crumb"
              >
                {collectionName}
              </Link>
            </span>
          )}
          <span className="mer-breadcrumb-sep" aria-hidden="true">
            /
          </span>
          <span className="mer-breadcrumb-title">{obj.title}</span>
        </nav>
        <span className="mer-badge mer-badge-live" data-testid="artifact-live-pill">
          ● LIVE ARTIFACT
        </span>
        <span className="mer-editor-topbar-spacer" />
        <div className="mer-editor-controls">
          <a href={`/nexus?workspace=${obj.id}`} className="mer-ectl">
            Open beside chat
          </a>
          <ArtifactTopbarActions artifactId={obj.id} readerHref={readerHref} />
          {userCanEdit && (
            <ContentSettings
              key={`settings-${obj.id}`}
              objectId={obj.id}
              title={obj.title}
              tags={obj.tags}
              collectionId={obj.collectionId}
              status={obj.status}
            />
          )}
          <VisibilityChip key={obj.id} idOrSlug={obj.id} />
          <Link
            // Full screen opens the chrome-free viewer route (#1052) — it works
            // for UNPUBLISHED artifacts and any viewer who canView, unlike the
            // /c and /p readers (which require a live publication). The readers
            // remain the Share targets (ArtifactTopbarActions, via readerHref).
            href={`/atrium/${obj.id}/view`}
            target="_blank"
            rel="noreferrer"
            className="mer-ectl mer-ectl-primary"
            data-testid="artifact-open-fullscreen"
          >
            Open full screen ↗
          </Link>
        </div>
      </div>

      <div className="mer-artifact-body" data-has-rail={userCanEdit ? "true" : "false"}>
        <div className="mer-artifact-canvas-col">
          <ArtifactCanvas
            key={obj.id}
            idOrSlug={obj.id}
            canEdit={userCanEdit}
            sandboxSrc={getArtifactSandboxRenderUrl()}
          />
        </div>
        {userCanEdit && (
          <ArtifactMetaRail
            artifactId={obj.id}
            agentMaintained={obj.createdByActor === "agent"}
            updatedAt={obj.updatedAt}
            versionNumber={currentVersion?.versionNumber ?? null}
            visibilityLevel={obj.visibilityLevel}
            backlinks={backlinks}
          />
        )}
      </div>
    </div>
  );
}

export default ArtifactAuthoringView;
