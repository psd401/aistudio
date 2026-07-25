"use client";

/**
 * Atrium PublishMenu — the Meridian "Publish ▾" split control (Epic #1059
 * polish; README editor topbar = breadcrumb · title · Suggesting ▾ · History ·
 * primary Publish ▾).
 *
 * Consolidates the four publish-cluster controls the old flat toolbar spread
 * across the topbar (a naked native destination `<select>`, a Publish button, a
 * separate Unpublish button, and a Snapshot button) into ONE dropdown:
 *  - a destination radio group (the editor-publishable destinations),
 *  - Publish / Unpublish acting on the picked destination,
 *  - "Save a version" (snapshot).
 *
 * #1336 makes it publication-state AWARE (B8) and audience-aware (C2):
 *  - It loads the object's live publications and its current visibility, marks
 *    each live destination, and DISABLES "Unpublish" for a destination that was
 *    never published (it previously offered both verbs for every destination —
 *    on never-published drafts included).
 *  - Publishing to a destination whose audience exceeds the doc's visibility
 *    opens a confirm dialog offering the atomic widen (Public for public web,
 *    Internal for intranet), executed through `publishDocumentAction`'s existing
 *    `visibility` parameter inside the service's existing transaction-gated
 *    path. A Private doc can no longer reach a plain "Published to intranet"
 *    success with a dead link and no warning.
 *  - The Schoology/Google "coming soon" entries are gone (C6). Their adapters
 *    reject as unimplemented stubs, so the rows were pure noise.
 *
 * The action handlers are owned by the parent (they target the resolved object
 * UUID and re-check permission server-side); this only chooses WHICH destination
 * they act on and whether a widen rides along. The dropdown and dialog portal to
 * document.body, so both carry `meridianPortalClassName` to render Meridian (not
 * global cream).
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Globe, Building2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { meridianPortalClassName } from "@/lib/atrium/meridian-fonts";
import { listPublicationsAction } from "@/actions/db/atrium/list-publications";
import { getVisibilityAction } from "@/actions/db/atrium/get-visibility";
import {
  widenNeededFor,
  VISIBILITY_LABELS,
} from "@/lib/atrium/publish-audience";
import type { VisibilityLevel } from "@/lib/content";
import type { EditorPublishDestination } from "@/actions/db/atrium/publish-document";
import { createLogger } from "@/lib/client-logger";

const log = createLogger({ component: "PublishMenu" });

/**
 * The picker's options — the destinations that actually publish something, in
 * menu order. The `schoology` / `google` entries were removed in #1336 (C6):
 * they were hardcoded `disabled: true` "coming soon" rows whose adapters throw
 * `implemented: false`, so they only ever advertised a dead end. The union type
 * still contains them (the server accepts them and rejects them authoritatively)
 * — this array is just what the menu offers.
 */
const DESTINATION_OPTIONS: ReadonlyArray<{
  value: EditorPublishDestination;
  label: string;
  short: string;
  icon: React.ReactNode;
}> = [
  {
    value: "intranet",
    label: "Intranet",
    short: "intranet",
    icon: <Building2 className="h-3.5 w-3.5" aria-hidden="true" />,
  },
  {
    value: "public_web",
    label: "Public web",
    short: "public web",
    icon: <Globe className="h-3.5 w-3.5" aria-hidden="true" />,
  },
];

/**
 * Load the object's live publications + current visibility so the menu can
 * reflect reality. Re-read via `reload()` after every publish/unpublish, and
 * whenever the menu is opened (another tab, or the VisibilityChip beside it, may
 * have changed things).
 */
function usePublishState(idOrSlug: string, refreshKey: number) {
  const [live, setLive] = useState<Set<string>>(() => new Set());
  const [visibility, setVisibility] = useState<VisibilityLevel | null>(null);

  // Bumped to force a re-read. Kept as state (rather than calling a `reload()`
  // function straight out of an effect) so the fetch and its setStates always
  // live INSIDE the effect's async IIFE — the pattern the rest of this codebase
  // uses, and the one that satisfies `react-hooks/set-state-in-effect`.
  const [seq, setSeq] = useState(0);
  const reload = useCallback(() => setSeq((n) => n + 1), []);

  // Readiness is tied to the COMPLETED request, not to "a read succeeded once".
  // A boolean latch would leave the menu enabled with STALE data while a re-read
  // is still in flight: reopening it after the adjacent Share control narrowed
  // Public → Private would keep serving the old Public value, so a fast click
  // would skip the required widen and create a `public_web` publication whose
  // reader still 404s — the exact #1336 C2 defect. Comparing the key that
  // produced the current data against the key being requested disables the
  // Publish item for the whole in-flight window, with no synchronous setState
  // in the effect body.
  const requestKey = `${idOrSlug}:${seq}:${refreshKey}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const ready = loadedKey === requestKey;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [pubs, vis] = await Promise.all([
          listPublicationsAction(idOrSlug),
          getVisibilityAction(idOrSlug),
        ]);
        if (cancelled) return;
        if (pubs.isSuccess) setLive(new Set(pubs.data.map((p) => p.destination)));
        else log.warn("listPublicationsAction failed", { message: pubs.message });
        if (vis.isSuccess) {
          setVisibility(vis.data.visibilityLevel);
          // Only a SUCCESSFUL visibility read marks this key loaded. A failed
          // read leaves the menu un-ready (Publish stays disabled) rather than
          // letting it act on a value it never obtained.
          setLoadedKey(requestKey);
        } else {
          log.warn("getVisibilityAction failed", { message: vis.message });
        }
      } catch (e) {
        if (cancelled) return;
        log.error("publish state load threw", {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [idOrSlug, requestKey]);

  return { live, visibility, ready, reload };
}

/**
 * The confirm dialog shown when the picked destination's audience exceeds the
 * doc's current visibility (#1336 C2). Confirming publishes WITH the widen in
 * the same gated action call; cancelling publishes nothing at all — deliberately
 * not "publish anyway", which is the exact broken state this dialog exists to
 * prevent (a live publication nobody can read).
 */
function WidenDialog({
  open,
  onOpenChange,
  destinationLabel,
  current,
  target,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  destinationLabel: string;
  current: VisibilityLevel;
  target: VisibilityLevel;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={meridianPortalClassName}>
        <DialogHeader>
          <DialogTitle>Widen who can see this?</DialogTitle>
          <DialogDescription>
            This document is currently{" "}
            <strong>{VISIBILITY_LABELS[current]}</strong>. Publishing it to the{" "}
            {destinationLabel} without changing that would create a live page
            that its readers cannot open.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Publishing will also set visibility to{" "}
          <strong>{VISIBILITY_LABELS[target]}</strong>
          {target === "public"
            ? " — anyone on the internet will be able to read it, no sign-in required."
            : " — anyone signed in to AI Studio will be able to read it."}
        </p>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm} data-testid="confirm-widen">
            Publish and set to {VISIBILITY_LABELS[target]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface PublishMenuProps {
  /** Content object id or slug — the publication/visibility state target. */
  idOrSlug: string;
  /** An edit action is in flight — disables the trigger + items. */
  busy: boolean;
  /**
   * Snapshot the working head. Optional: artifacts have no topbar snapshot (their
   * versions come from the canvas save path), so `ArtifactPublishControl` omits
   * it and the "Save a version" item is hidden.
   */
  onSnapshot?: () => void;
  /**
   * Publish to `destination`. `widenTo` (when set) rides along as the action's
   * existing `visibility` parameter so the widen and the publish commit in ONE
   * transaction.
   */
  onPublish: (
    destination: EditorPublishDestination,
    widenTo?: VisibilityLevel
  ) => void;
  onUnpublish: (destination: EditorPublishDestination) => void;
  /**
   * Bumped by the parent after any publish/unpublish completes, so the menu
   * re-reads live state instead of showing what it loaded on mount.
   */
  refreshKey?: number;
}

export function PublishMenu({
  idOrSlug,
  busy,
  onSnapshot,
  onPublish,
  onUnpublish,
  refreshKey = 0,
}: PublishMenuProps): React.JSX.Element {
  // The picked destination drives BOTH Publish and Unpublish (one control, as the
  // spec asked); intranet is the default.
  const [destination, setDestination] =
    useState<EditorPublishDestination>("intranet");
  const [pendingWiden, setPendingWiden] = useState<VisibilityLevel | null>(null);
  const current =
    DESTINATION_OPTIONS.find((o) => o.value === destination) ??
    DESTINATION_OPTIONS[0];

  // `refreshKey` (bumped by the parent after every publish/unpublish) and the
  // menu opening are the two re-read triggers.
  const { live, visibility, ready, reload } = usePublishState(idOrSlug, refreshKey);

  const isLive = live.has(destination);

  const handlePublishClick = useCallback(() => {
    // Never reached with an unresolved visibility — the item is disabled until
    // `ready` (see below). Guarded anyway so a future caller cannot skip the
    // audience check by accident.
    if (!visibility) return;
    const widen = widenNeededFor(destination, visibility);
    if (widen) {
      // Deferred by a macrotask on purpose. Radix closes the dropdown on select
      // and runs its dismissable-layer teardown in the SAME tick, so a Dialog
      // opened synchronously here is caught by that dismissal and closes again
      // immediately — the confirm never appears. Letting the dropdown fully
      // unmount first is the documented way to open a dialog from a menu item.
      setTimeout(() => setPendingWiden(widen), 0);
      return;
    }
    onPublish(destination);
  }, [destination, visibility, onPublish]);

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && void reload()}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="mer-ectl mer-ectl-primary"
            disabled={busy}
            data-testid="publish-menu-trigger"
          >
            Publish
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className={meridianPortalClassName}
          align="end"
          sideOffset={6}
        >
          <DropdownMenuLabel>Destination</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={destination}
            onValueChange={(v) => setDestination(v as EditorPublishDestination)}
          >
            {DESTINATION_OPTIONS.map((o) => (
              <DropdownMenuRadioItem
                key={o.value}
                value={o.value}
                className="gap-2"
                // Keep the menu OPEN when picking a destination (Radix closes it by
                // default on select) so the user can then click Publish/Unpublish in
                // the same dropdown without reopening it.
                onSelect={(e) => e.preventDefault()}
                data-testid={`destination-${o.value}`}
              >
                {o.icon}
                {o.label}
                {live.has(o.value) && (
                  <span
                    className="mer-badge mer-badge-live ml-auto"
                    data-testid={`live-${o.value}`}
                  >
                    Live
                  </span>
                )}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            // Disabled until the audience state is known: publishing without it
            // cannot evaluate the widen check, and doing so anyway is exactly
            // the #1336 C2 defect (a live page its readers cannot open).
            disabled={busy || !ready}
            onSelect={handlePublishClick}
            data-testid="publish-item"
          >
            {ready
              ? `${isLive ? "Republish to" : "Publish to"} ${current.short}`
              : "Checking visibility…"}
          </DropdownMenuItem>
          <DropdownMenuItem
            // #1336 B8: unpublishing a destination with nothing live is a no-op
            // the menu used to offer anyway, on never-published drafts included.
            disabled={busy || !isLive}
            onSelect={() => onUnpublish(destination)}
            className="text-destructive focus:text-destructive"
            data-testid="unpublish-item"
          >
            Unpublish from {current.short}
          </DropdownMenuItem>
          {onSnapshot && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={busy} onSelect={onSnapshot}>
                Save a version
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {pendingWiden && visibility && (
        <WidenDialog
          open
          onOpenChange={(next) => !next && setPendingWiden(null)}
          destinationLabel={current.short}
          current={visibility}
          target={pendingWiden}
          onConfirm={() => {
            const widen = pendingWiden;
            setPendingWiden(null);
            onPublish(destination, widen);
          }}
        />
      )}
    </>
  );
}
