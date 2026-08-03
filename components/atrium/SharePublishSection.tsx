"use client";

/**
 * "Where it's published" — the destination rows inside the Share dialog.
 *
 * ## Why this replaced the Publish ▾ menu
 *
 * Sharing was spread across three controls that each owned part of one idea: a
 * "Share" button that silently copied a link, a "Share" dialog that set
 * visibility, and a "Publish ▾" dropdown that created publications. Nothing said
 * they were related — yet a working link requires ALL of them to agree, and the
 * two most common broken states (public visibility with no publication, a
 * publication with non-public visibility) are exactly what you get when you use
 * one control and not the others. Putting the destinations in the same dialog as
 * the audience makes the dependency visible instead of tribal knowledge.
 *
 * ## What was preserved
 *
 * The widen check and its revalidation are carried over verbatim from the old
 * menu, including the reason they exist:
 *
 *  - Publishing to a destination whose audience exceeds the object's visibility
 *    prompts BEFORE publishing. Cancelling publishes nothing — deliberately not
 *    "publish anyway", which is the broken state (a live page its readers cannot
 *    open) this check exists to prevent.
 *  - Confirming RE-READS visibility and recomputes the widen against that fresh
 *    value rather than the snapshot the prompt opened with. The snapshot can go
 *    stale (another tab, or the audience control directly above this section),
 *    and the publish transaction applies whatever visibility it is handed under
 *    its row lock — so confirming what is PRESENTED as a widen could otherwise
 *    silently NARROW an object that had concurrently become Public.
 *  - A failed re-read does NOT fall back to the snapshot; it surfaces an inline
 *    error, because publishing on an unverifiable audience is the whole defect.
 *
 * The confirmation is an inline STEP in this section rather than a nested
 * dialog: a dialog inside a dialog fights the outer one's dismissable layer, and
 * the confirmation belongs to this section anyway.
 */

import { useCallback, useState } from "react";
import { Globe, Building2, Loader2 } from "lucide-react";
import { getVisibilityAction } from "@/actions/db/atrium/get-visibility";
import {
  widenNeededFor,
  VISIBILITY_LABELS,
} from "@/lib/atrium/publish-audience";
import type { EditorPublishDestination } from "@/actions/db/atrium/publish-document";
import type { VisibilityLevel } from "@/lib/content";
import { createLogger } from "@/lib/client-logger";
import { cn } from "@/lib/utils";

const log = createLogger({ component: "SharePublishSection" });

interface DestinationOption {
  value: EditorPublishDestination;
  label: string;
  short: string;
  blurb: string;
  icon: React.ReactNode;
}

const DESTINATIONS: readonly DestinationOption[] = [
  {
    value: "intranet",
    label: "The intranet",
    short: "the intranet",
    blurb: "Anyone signed in to AI Studio who can already see it.",
    icon: <Building2 className="h-4 w-4" aria-hidden="true" />,
  },
  {
    value: "public_web",
    label: "The public web",
    short: "the public web",
    blurb: "Anyone with the link, no sign-in. Requires Public visibility.",
    icon: <Globe className="h-4 w-4" aria-hidden="true" />,
  },
];

/** The inline widen confirmation step. See the file header for why it is inline. */
function WidenConfirm({
  current,
  widenTo,
  destinationShort,
  confirming,
  error,
  onCancel,
  onConfirm,
}: {
  current: VisibilityLevel;
  widenTo: VisibilityLevel;
  destinationShort: string;
  confirming: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <div className="mer-share-confirm" data-testid="share-widen-confirm">
      <p className="mer-share-confirm-title">Widen who can see this?</p>
      <p className="mer-share-confirm-body">
        It is currently <strong>{VISIBILITY_LABELS[current]}</strong>. Publishing
        it to {destinationShort} without changing that would create a live page
        its readers cannot open. Publishing will also set visibility to{" "}
        <strong>{VISIBILITY_LABELS[widenTo]}</strong>
        {widenTo === "public"
          ? " — anyone on the internet will be able to read it, no sign-in required."
          : " — anyone signed in to AI Studio will be able to read it."}
      </p>
      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <div className="mer-share-confirm-actions">
        <button type="button" className="mer-btn" disabled={confirming} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="mer-btn mer-btn-primary"
          disabled={confirming}
          onClick={onConfirm}
          data-testid="share-widen-confirm-button"
        >
          {confirming ? "Checking…" : "Widen and publish"}
        </button>
      </div>
    </div>
  );
}

/** One destination row: what it means, whether it is live, and the actions. */
function DestinationRow({
  option,
  isLive,
  canEdit,
  busy,
  visibilityKnown,
  onPublish,
  onUnpublish,
}: {
  option: DestinationOption;
  isLive: boolean;
  canEdit: boolean;
  busy: boolean;
  /** Publishing is blocked until the audience is known — see the header. */
  visibilityKnown: boolean;
  onPublish: () => void;
  onUnpublish: () => void;
}): React.JSX.Element {
  return (
    <div
      className="mer-share-dest"
      data-live={isLive ? "true" : "false"}
      data-testid={`share-dest-${option.value}`}
    >
      <span className="mer-share-dest-icon" aria-hidden="true">
        {option.icon}
      </span>
      <div className="mer-share-dest-text">
        <p className="mer-share-dest-label">
          {option.label}
          {isLive && (
            <span
              className="mer-badge mer-badge-live"
              data-testid={`live-${option.value}`}
            >
              Live
            </span>
          )}
        </p>
        <p className="mer-share-dest-blurb">{option.blurb}</p>
      </div>
      {canEdit && (
        <div className="mer-share-dest-actions">
          <button
            type="button"
            className={cn("mer-btn", !isLive && "mer-btn-primary")}
            disabled={busy || !visibilityKnown}
            onClick={onPublish}
            data-testid={`share-publish-${option.value}`}
          >
            {!visibilityKnown ? "Checking…" : isLive ? "Republish" : "Publish"}
          </button>
          {isLive && (
            <button
              type="button"
              className="mer-btn mer-btn-danger"
              disabled={busy}
              onClick={onUnpublish}
              data-testid={`share-unpublish-${option.value}`}
            >
              Unpublish
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export interface SharePublishSectionProps {
  /** Destinations with a live publication right now. */
  live: ReadonlySet<string>;
  /** The object's saved visibility, or null while it is still unknown. */
  visibility: VisibilityLevel | null;
  /** A publish/unpublish is in flight upstream. */
  busy: boolean;
  canEdit: boolean;
  /** Content object id or slug — used to re-read visibility on confirm. */
  idOrSlug: string;
  onPublish: (
    destination: EditorPublishDestination,
    widenTo?: VisibilityLevel
  ) => void;
  onUnpublish: (destination: EditorPublishDestination) => void;
}

export function SharePublishSection({
  live,
  visibility,
  busy,
  canEdit,
  idOrSlug,
  onPublish,
  onUnpublish,
}: SharePublishSectionProps): React.JSX.Element {
  const [pending, setPending] = useState<{
    destination: EditorPublishDestination;
    widenTo: VisibilityLevel;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  const requestPublish = useCallback(
    (destination: EditorPublishDestination) => {
      // Unreachable with an unknown audience — the buttons are disabled until
      // visibility resolves. Guarded anyway so a future caller cannot skip the
      // audience check by accident.
      if (!visibility) return;
      const widenTo = widenNeededFor(destination, visibility);
      if (widenTo) {
        setPending({ destination, widenTo });
        setConfirmError(null);
        return;
      }
      onPublish(destination);
    },
    [visibility, onPublish]
  );

  const confirmWiden = useCallback(() => {
    if (!pending) return;
    setConfirming(true);
    setConfirmError(null);
    void (async () => {
      try {
        const vis = await getVisibilityAction(idOrSlug);
        if (!vis.isSuccess) {
          log.warn("widen revalidation failed", { message: vis.message });
          setConfirmError(
            "Could not confirm who can currently see this. Please try again."
          );
          setConfirming(false);
          return;
        }
        // Recompute against the FRESH level — see the file header. This can
        // never contradict what was confirmed ("make it readable there"), so
        // there is no second prompt: it is either the same widen, or none
        // because the object already reaches further.
        const widenTo = widenNeededFor(pending.destination, vis.data.visibilityLevel);
        setConfirming(false);
        const destination = pending.destination;
        setPending(null);
        onPublish(destination, widenTo ?? undefined);
      } catch (e) {
        log.error("widen revalidation threw", {
          error: e instanceof Error ? e.message : String(e),
        });
        setConfirmError(
          "Could not confirm who can currently see this. Please try again."
        );
        setConfirming(false);
      }
    })();
  }, [pending, idOrSlug, onPublish]);

  if (pending && visibility) {
    return (
      <WidenConfirm
        current={visibility}
        widenTo={pending.widenTo}
        destinationShort={
          DESTINATIONS.find((d) => d.value === pending.destination)?.short ??
          "that destination"
        }
        confirming={confirming}
        error={confirmError}
        onCancel={() => {
          setPending(null);
          setConfirmError(null);
        }}
        onConfirm={confirmWiden}
      />
    );
  }

  return (
    <div className="mer-share-dests">
      {DESTINATIONS.map((option) => (
        <DestinationRow
          key={option.value}
          option={option}
          isLive={live.has(option.value)}
          canEdit={canEdit}
          busy={busy}
          visibilityKnown={visibility !== null}
          onPublish={() => requestPublish(option.value)}
          onUnpublish={() => onUnpublish(option.value)}
        />
      ))}
      {busy && (
        <p className="mer-share-dest-busy" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{" "}
          Working…
        </p>
      )}
    </div>
  );
}

export default SharePublishSection;
