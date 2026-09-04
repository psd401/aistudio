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
import { AlertTriangle } from "lucide-react";
import type { ContentObjectDTO, Requester } from "@/lib/content/types";
import { versionService } from "@/lib/content/version-service";
import { listEmbeddingDocuments } from "@/lib/content/embed-backlinks";
import { getArtifactSandboxRenderUrl } from "@/lib/content/artifact-sandbox-config";
import { ArtifactCanvas } from "./ArtifactCanvas";
import { ArtifactMetaRail } from "./ArtifactMetaRail";
import { ContentSettings } from "./ContentSettings";
import { VisibilityChip } from "./VisibilityChip";
import { publishService } from "@/lib/content/publish-service";
import {
  publicBlockers,
  PUBLIC_BLOCKER_TEXT,
} from "@/lib/content/public-reachability";

export interface ArtifactAuthoringViewProps {
  obj: ContentObjectDTO;
  /** The resolved session principal (rail backlinks are filtered to its view). */
  req: Requester;
  /** Whether the viewer may manage the artifact (gates the rail + settings). */
  userCanEdit: boolean;
  /** The collection name for the breadcrumb, or null when uncollected. */
  collectionName: string | null;
  /** The section's slug, so the breadcrumb reaches its landing page. */
  collectionSlug: string | null;
}

export async function ArtifactAuthoringView({
  obj,
  req,
  userCanEdit,
  collectionName,
  collectionSlug,
}: ArtifactAuthoringViewProps): Promise<React.JSX.Element> {
  // Publication state, read here only to decide whether the broken-public-link
  // banner below applies. The Share dialog loads its own copy for the link and
  // the destination rows.
  const publications = await publishService.listLive(req, obj.id);
  const publicPub = publications.find((p) => p.destination === "public_web");

  // A live public_web publication is NOT sufficient for /p/[slug] to render —
  // the route also requires public visibility AND a section an anonymous
  // visitor can enter. Without this, an author sees "Public web · LIVE", copies
  // the URL, and everyone who opens it gets a 404 with nothing anywhere saying
  // why. Only computed when something is actually published publicly; there is
  // no broken link to warn about otherwise.
  const publicIssues = publicPub
    ? await publicBlockers({
        hasLivePublicWebPublication: true,
        visibilityLevel: obj.visibilityLevel,
        collectionId: obj.collectionId,
      })
    : [];

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
      {publicIssues.length > 0 && (
        <div className="mer-public-warning" role="status" data-testid="public-link-warning">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <div>
            <p className="mer-public-warning-title">
              This page is published publicly, but the public link will not open.
            </p>
            <ul className="mer-public-warning-list">
              {publicIssues.map((issue) => (
                <li key={issue}>{PUBLIC_BLOCKER_TEXT[issue]}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <div className="mer-editor-topbar">
        <nav className="mer-breadcrumb" aria-label="Breadcrumb">
          <Link href="/atrium" className="mer-breadcrumb-crumb">
            Library
          </Link>
          {collectionName && collectionSlug && (
            <span className="mer-breadcrumb-crumb-group">
              <span className="mer-breadcrumb-sep" aria-hidden="true">
                /
              </span>{" "}
              <Link
                // The section's OWN page, not the old `?collection=<uuid>`
                // filter — that re-rendered the flat grid with no hero.
                href={`/atrium/s/${collectionSlug}`}
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
          {userCanEdit && (
            <ContentSettings
              key={`settings-${obj.id}`}
              objectId={obj.id}
              title={obj.title}
              tags={obj.tags}
              collectionId={obj.collectionId}
              status={obj.status}
              kind={obj.kind}
              dataAccess={obj.dataAccess}
            />
          )}
          {/* ONE share surface. The link, the audience, the destinations, and
              the embed code all live in this dialog — they used to be three
              separate controls (a silent copy-link button, this chip, and a
              Publish ▾ menu) that had to agree for a link to work and never
              said so. */}
          <VisibilityChip
            key={obj.id}
            idOrSlug={obj.id}
            share={{ objectId: obj.id, slug: obj.slug, kind: "artifact" }}
          />
          <Link
            // Full screen opens the chrome-free viewer route (#1052) — it works
            // for UNPUBLISHED artifacts and any viewer who canView, unlike the
            // /c and /p readers (which require a live publication). The Share
            // dialog resolves its own link with the same precedence.
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
            // #1725: the editor preview runs the artifact data bridge, so a
            // `query`-mode dashboard can be exercised before it is published.
            // The page that renders this view already ran the 404-masking
            // canView gate, and every bridge action repeats it — publication
            // was never the authorization for a data call.
            dataBridgeEnabled={true}
            contentId={obj.id}
            // The mode as read for THIS render; the sandbox pins it for the
            // life of its mount (#1712).
            dataAccess={obj.dataAccess}
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
