"use client";

/**
 * Atrium ArtifactPublishControl — publish/unpublish for an artifact (#1336 C4).
 *
 * Only DOCUMENTS mounted `PublishMenu`, so an artifact could never gain a
 * `public_web` publication from the UI at all — yet its Share button happily
 * copied `/p/{slug}` as soon as visibility was Public, which 404s without that
 * publication. This is the missing control.
 *
 * A thin client wrapper: it reuses the same `PublishMenu` (destination picker,
 * live badges, the audience confirm dialog) and the same gated server actions as
 * the document editor. "Save a version" is omitted — an artifact's versions are
 * created by the canvas save path, not by a topbar snapshot — which is why
 * `PublishMenu.onSnapshot` is optional.
 */

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { PublishMenu } from "./PublishMenu";
import { CopyableLink } from "./CopyableLink";
import {
  publishDocumentAction,
  type EditorPublishDestination,
} from "@/actions/db/atrium/publish-document";
import { unpublishDocumentAction } from "@/actions/db/atrium/unpublish-document";
import type { VisibilityLevel } from "@/lib/content";
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "ArtifactPublishControl" });

const DESTINATION_LABELS: Record<string, string> = {
  intranet: "the intranet",
  public_web: "the public web",
};

export function ArtifactPublishControl({
  artifactId,
}: {
  artifactId: string;
}): React.JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageUrl, setMessageUrl] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [seq, setSeq] = useState(0);

  const finish = useCallback(
    (
      text: string,
      {
        url = null as string | null,
        error = false,
        // Set when publication state actually changed on the server, so the
        // server-rendered surface above this control is re-derived.
        refreshRoute = false,
      } = {},
    ) => {
      setMessage(text);
      setMessageUrl(url);
      setIsError(error);
      setSeq((n) => n + 1);
      setBusy(false);
      // `ArtifactAuthoringView` resolves the Share target (`readerHref`) on the
      // SERVER from live publication state. `seq` above only re-reads the
      // menu's own state, so without this the Share button kept copying the
      // pre-action URL: a freshly published artifact still shared the
      // authenticated `/atrium/{id}/view` fallback, and an unpublished one went
      // on handing out a now-dead `/p/…` or `/c/…` link until a manual reload.
      if (refreshRoute) router.refresh();
    },
    [router],
  );

  const handlePublish = useCallback(
    (destination: EditorPublishDestination, widenTo?: VisibilityLevel) => {
      const label = DESTINATION_LABELS[destination] ?? destination;
      setBusy(true);
      void (async () => {
        try {
          const res = await publishDocumentAction(artifactId, {
            destination,
            // `widenOnly`: an OFFER, not an assignment — see use-editor-actions.
            ...(widenTo
              ? { visibility: { level: widenTo, widenOnly: true } }
              : {}),
          });
          if (res.isSuccess) {
            finish(`Published to ${label}`, {
              url: res.data.readerUrl,
              refreshRoute: true,
            });
          } else {
            // A §26.4 pending-approval outcome is not a failure; the in-app
            // surface grants authors public-publish authority (#1336), so this
            // is a genuine error path for humans.
            finish(res.message ?? "Publish failed", {
              error: !res.approvalRequired,
            });
            log.warn("publishDocumentAction failed", { message: res.message });
          }
        } catch (e) {
          finish("Publish failed — please try again.", { error: true });
          log.error("publishDocumentAction threw", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })();
    },
    [artifactId, finish],
  );

  const handleUnpublish = useCallback(
    (destination: EditorPublishDestination) => {
      const label = DESTINATION_LABELS[destination] ?? destination;
      if (
        typeof window !== "undefined" &&
        !window.confirm(
          `Unpublish this artifact from ${label}? Readers will no longer see it (you can republish later).`,
        )
      ) {
        return;
      }
      setBusy(true);
      void (async () => {
        try {
          const res = await unpublishDocumentAction(artifactId, {
            destination,
          });
          if (res.isSuccess) {
            finish(
              res.data.unpublished
                ? `Unpublished from ${label}`
                : "Not currently published there",
              // Only a real retraction moved the share target; "nothing was
              // published there" changed no server state worth re-fetching.
              { refreshRoute: res.data.unpublished },
            );
          } else {
            finish(res.message ?? "Unpublish failed", {
              error: !res.approvalRequired,
            });
          }
        } catch (e) {
          finish("Unpublish failed — please try again.", { error: true });
          log.error("unpublishDocumentAction threw", {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })();
    },
    [artifactId, finish],
  );

  return (
    <>
      <PublishMenu
        idOrSlug={artifactId}
        busy={busy}
        refreshKey={seq}
        onPublish={handlePublish}
        onUnpublish={handleUnpublish}
      />
      {message && (
        <span
          className="mer-editor-status"
          data-tone={isError ? "error" : "info"}
          aria-live="polite"
          data-testid="artifact-publish-status"
        >
          {message}
          {messageUrl && (
            <>
              {" — "}
              <CopyableLink url={messageUrl} testId="artifact-reader-url" />
            </>
          )}
        </span>
      )}
    </>
  );
}

export default ArtifactPublishControl;
