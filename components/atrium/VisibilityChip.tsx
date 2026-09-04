"use client";

/**
 * Atrium VisibilityChip + visibility editor (#1053, Epic #1059, spec §12 / §17)
 *
 * The shared panel-header control that shows an object's current visibility level
 * and opens the visibility editor: a level picker (private / group / internal /
 * public) plus a group-grant builder (role / building / department / grade / user /
 * group grants). It reads the current state via `getVisibilityAction` and persists
 * via `setVisibilityAction` — both of which run the `canView` + `assertCanEdit`
 * gates server-side, so this UI is presentation only (no authorization logic here).
 *
 * Grant value semantics (mirror visibility-service §12.2):
 * - role        — a role NAME (selected from the role list), matched against the
 *                 viewer's roles.
 * - building / department / grade — a free-form `users` attribute string.
 * - user        — a numeric `users.id`.
 * - group       — a synced Google group EMAIL (selected from the group list),
 *                 matched against the viewer's group memberships (#1205).
 *
 * For a viewer who cannot edit (not owner/admin), the chip renders read-only:
 * the badge shows the level, the dialog's controls are disabled, and Save is
 * hidden. The server re-checks edit permission regardless.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { publishDocumentAction } from "@/actions/db/atrium/publish-document";
import { LIVE_DESTINATION } from "@/lib/content/publish-adapters/types";
import { isLive } from "@/lib/content/live-publication";
import { unpublishDocumentAction } from "@/actions/db/atrium/unpublish-document";
import { ShareLinkSection } from "./ShareLinkSection";
import { SharePublishSection } from "./SharePublishSection";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Globe, Lock, Users, Building2, Share2, X } from "lucide-react";
import { getVisibilityAction } from "@/actions/db/atrium/get-visibility";
import { setVisibilityAction } from "@/actions/db/atrium/set-visibility";
import { listGrantOptionsAction } from "@/actions/db/atrium/list-grant-options";
import { meridianPortalClassName } from "@/lib/meridian/fonts";
import { listPublicationsAction } from "@/actions/db/atrium/list-publications";
import { PeoplePicker } from "./PeoplePicker";

/** The visibility levels, in widening order, with their picker labels. */
const LEVELS = [
  { value: "private", label: "Private", help: "Only you (and admins)." },
  { value: "group", label: "Group", help: "Specific roles, buildings, departments, grades, people, or Google groups." },
  { value: "internal", label: "Internal", help: "Any signed-in user." },
  { value: "public", label: "Public", help: "Anyone, including signed-out visitors." },
] as const;
type Level = (typeof LEVELS)[number]["value"];

const GRANT_KINDS = [
  { value: "role", label: "Role" },
  { value: "building", label: "Building" },
  { value: "department", label: "Department" },
  { value: "grade", label: "Grade" },
  { value: "user", label: "Person" },
  { value: "group", label: "Google group" },
] as const;
type GrantKind = (typeof GRANT_KINDS)[number]["value"];

interface Grant {
  kind: GrantKind;
  value: string;
}

/** A selectable synced group (email is stored; name is display-only). */
interface GroupOption {
  email: string;
  name: string | null;
}

/** Badge variant + icon + label for a level (the at-a-glance chip). */
function levelChrome(level: Level): {
  variant: "ghost" | "info" | "warning" | "success";
  icon: React.ReactNode;
  label: string;
} {
  switch (level) {
    case "public":
      return { variant: "success", icon: <Globe className="h-3 w-3" />, label: "Public" };
    case "internal":
      return { variant: "info", icon: <Building2 className="h-3 w-3" />, label: "Internal" };
    case "group":
      return { variant: "warning", icon: <Users className="h-3 w-3" />, label: "Group" };
    case "private":
      return { variant: "ghost", icon: <Lock className="h-3 w-3" />, label: "Private" };
    default:
      // Exhaustiveness guard: adding a new Level to LEVELS without a case here is
      // a compile error, not a silent fall-through to a "Private" lock badge.
      return assertNeverLevel(level);
  }
}

/**
 * Compile-time exhaustiveness check for `Level`. The `never` parameter makes
 * TypeScript reject any call reached with an unhandled level; the runtime fallback
 * keeps the chip rendering if an out-of-band value ever slips past the type.
 */
function assertNeverLevel(level: never): LevelChrome {
  return { variant: "ghost", icon: <Lock className="h-3 w-3" />, label: String(level) };
}

type LevelChrome = ReturnType<typeof levelChrome>;

/**
 * The at-a-glance badge inside the chip's trigger button. Until the real level
 * is KNOWN (the fetch succeeded — `levelKnown`) it shows a neutral placeholder
 * instead of the default `private` chrome — otherwise an object that is actually
 * public/internal/group would flash a "Private" lock badge while the fetch is in
 * flight, OR permanently show one if the fetch failed (level never learned).
 */
function ChipBadge({
  levelKnown,
  chrome,
}: {
  levelKnown: boolean;
  chrome: LevelChrome;
}) {
  if (!levelKnown) {
    return (
      <Badge variant="ghost" className="gap-1 opacity-50">
        Visibility…
      </Badge>
    );
  }
  return (
    <Badge variant={chrome.variant} className="gap-1 cursor-pointer">
      {chrome.icon}
      {chrome.label}
    </Badge>
  );
}

export interface VisibilityChipProps {
  /** Content object id or slug (the actions resolve a slug to the UUID). */
  idOrSlug: string;
  /**
   * The object's stable UUID and slug. Required for the Link and Publish
   * sections: a link needs the slug, and the embed directive needs the id, and
   * `idOrSlug` may be either one. Omit them to render the audience controls
   * alone (the legacy visibility-only chip).
   */
  share?: {
    objectId: string;
    slug: string;
    kind: "document" | "artifact";
  };
  /**
   * Called after a successful save with the new level, so a parent can reflect
   * it without re-fetching (the chip already updates its own badge).
   */
  onChange?: (level: Level) => void;
}

/**
 * Lazily load the grant options the role/group-grant dropdowns need (only an editor
 * with the GROUP level open needs them). One fetch resolves both the role names and
 * the synced group list. A boolean ref guards against a re-fetch after a SUCCESSFUL
 * load — but it is set ONLY on success, so a transient failure leaves it `false` and
 * the next time the load condition becomes true again the effect retries.
 *
 * `groupActive` (level === "group") is a dep precisely so that retry path works: a
 * failed load while on `group` leaves the dropdowns empty, and switching the level
 * picker away from `group` and back re-runs this effect (groupActive flips
 * false→true) to retry — otherwise a one-time network blip would strand the dropdowns
 * empty for the entire dialog session with no escape but closing and reopening.
 * `options` length is intentionally NOT a dep (depending on it would re-run on
 * every option-list change).
 *
 * NOTE: a boolean ref is correct HERE (unlike the parameterized-route anti-pattern
 * in CLAUDE.md) because the option lists are GLOBAL — they do not depend on
 * `idOrSlug` or any other prop, so they never need to reset for a different id. The
 * parent additionally keys `VisibilityChip` on `obj.id`, so the whole component (and
 * this ref) remounts on navigation regardless. Extracted from the component to keep
 * its body under the max-lines lint cap and to isolate the fetch lifecycle.
 */
function useGrantOptions(
  open: boolean,
  canEdit: boolean,
  groupActive: boolean,
  onError: (message: string) => void
): { roles: string[]; groups: GroupOption[] } {
  const [roleOptions, setRoleOptions] = useState<string[]>([]);
  const [groupOptions, setGroupOptions] = useState<GroupOption[]>([]);
  const optionsLoaded = useRef(false);
  useEffect(() => {
    if (!open || !canEdit || !groupActive || optionsLoaded.current) return;
    let cancelled = false;
    void (async () => {
      // try/catch so a THROWN fetch (network error) still surfaces an error
      // rather than silently leaving the dropdowns empty with no explanation.
      try {
        const result = await listGrantOptionsAction();
        if (cancelled) return;
        if (result.isSuccess) {
          optionsLoaded.current = true;
          setRoleOptions(result.data.roles);
          // `?? []` defends against an older action shape (or a partial test mock)
          // that omits `groups` — an undefined would break the picker's `.map`.
          setGroupOptions(result.data.groups ?? []);
        } else {
          // Surface the failure so the user knows why the dropdowns are empty.
          // `optionsLoaded` stays false, so returning to the group editor
          // (groupActive false→true) retries this load.
          onError(result.message);
        }
      } catch {
        if (!cancelled) {
          // Same retry-on-return semantics as the !isSuccess branch above:
          // `optionsLoaded` is untouched, so the load reattempts when the
          // user switches the level picker back to `group`.
          onError("Failed to load grant options — switch the level away and back to retry.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, canEdit, groupActive, onError]);
  return { roles: roleOptions, groups: groupOptions };
}

/**
 * Mirror the server's grant reconciliation so the chip's local `savedGrants` never
 * diverges from what was actually persisted: group keeps all supplied grants,
 * private PRESERVES `user`-kind grants (both read paths honor them), internal/public
 * clear everything. Values are trimmed, `group` emails lowercased, and
 * (kind,value)-deduped to match the server's `applyGrantsInTx` normalization —
 * otherwise a later Cancel would restore un-normalized draft values as the "last
 * persisted" state.
 */
function reconcileSavedGrants(level: Level, grants: Grant[]): Grant[] {
  const kept =
    level === "group"
      ? grants
      : level === "private"
        ? grants.filter((g) => g.kind === "user")
        : [];
  const seen = new Set<string>();
  const normalized: Grant[] = [];
  for (const g of kept) {
    // `group` values are lowercased (emails are case-insensitive); other kinds
    // keep their case — mirrors the server's `normalizeGrantValue`.
    const trimmed = g.value.trim();
    const value = g.kind === "group" ? trimmed.toLowerCase() : trimmed;
    const key = `${g.kind}:${value}`;
    if (value.length === 0 || seen.has(key)) continue;
    seen.add(key);
    normalized.push({ kind: g.kind, value });
  }
  return normalized;
}

/**
 * Persist a visibility change and apply the resulting local state. Extracted to a
 * module-level helper (taking the component's setters) so the component body stays
 * under the max-lines lint cap, mirroring the `useRoleOptions` extraction.
 *
 * The try/catch/finally guarantees `setSaving(false)` always runs even when the
 * server action THROWS (network error, server crash) — otherwise the dialog would
 * be stranded in the "Saving…" state with Save+Cancel permanently disabled.
 */
async function performVisibilitySave(
  idOrSlug: string,
  level: Level,
  grants: Grant[],
  setters: {
    setSaving: (v: boolean) => void;
    setError: (v: string | null) => void;
    setPendingApproval: (v: string | null) => void;
    setSavedLevel: (v: Level) => void;
    setSavedGrants: (v: Grant[]) => void;
    setOpen: (v: boolean) => void;
    onChange?: (level: Level) => void;
  }
): Promise<void> {
  const {
    setSaving,
    setError,
    setPendingApproval,
    setSavedLevel,
    setSavedGrants,
    setOpen,
    onChange,
  } = setters;
  setSaving(true);
  setError(null);
  setPendingApproval(null);
  // A group object with no grants is visible to no one but the owner/admin —
  // block the save client-side with a clear message (the service also rejects).
  if (level === "group" && grants.length === 0) {
    setError("Group visibility needs at least one grant.");
    setSaving(false);
    return;
  }
  try {
    const result = await setVisibilityAction(idOrSlug, {
      level,
      // Grants are only sent for `group`; other levels clear them server-side.
      grants: level === "group" ? grants : [],
    });
    if (result.isSuccess) {
      const newLevel = result.data.visibilityLevel as Level;
      setSavedLevel(newLevel);
      setSavedGrants(reconcileSavedGrants(newLevel, grants));
      setOpen(false);
      onChange?.(newLevel);
    } else if (result.approvalRequired) {
      // Not an error — the §26.4 gate accepted the request into the approval
      // queue. Show it as a distinct pending notice, not a red failure.
      setPendingApproval(result.message);
    } else {
      setError(result.message);
    }
  } catch {
    setError("Failed to save — please try again.");
  } finally {
    setSaving(false);
  }
}

/**
 * Whether the object is LIVE (#1726 — one publication state, not a set of
 * destinations). Loaded only while the dialog is open, which keeps the chip's
 * mount cost at exactly one request.
 *
 * `loaded` stays false on any failure. That distinction is load-bearing: an
 * UNKNOWN state must render no confident claim about where the object is
 * readable, because "still a draft" shown over a live page is exactly the
 * misinformation this dialog exists to remove.
 */
function useLivePublication(
  idOrSlug: string,
  active: boolean,
  /** Bumped after every publish/unpublish so the section re-reads live state. */
  refreshKey = 0
) {
  const [state, setState] = useState<LivePublicationState>({
    loaded: false,
    live: false,
  });

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await listPublicationsAction(idOrSlug);
        if (cancelled) return;
        if (!res.isSuccess) {
          // `isSuccess === false` is the NORMAL error channel (`handleError`
          // returns it; only an exception reaches the catch below). Treating it
          // as "not live" would confidently tell the owner their live page is
          // still a draft — a false claim about the exact thing this dialog
          // exists to get right. Stay UNKNOWN: `loaded` false disables the
          // actions and shows no consequence line.
          setState({ loaded: false, live: false });
          return;
        }
        setState({
          loaded: true,
          live: isLive(res.data.map((p) => p.destination)),
        });
      } catch {
        // Leave `loaded` false: an unknown state must not render a confident
        // "still a draft" claim that might be wrong.
        if (!cancelled) {
          setState({ loaded: false, live: false });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [idOrSlug, active, refreshKey]);

  return state;
}

/** Live-publication state, as loaded for the Share dialog. */
interface LivePublicationState {
  /** False until the read lands — and after any failure (see the hook). */
  loaded: boolean;
  /** The object has a live publication. */
  live: boolean;
}

/**
 * The Share dialog's body: level picker, grant builder, the Public consequence
 * notice, feedback, and the footer. Presentational — every mutation is a
 * callback into `VisibilityChip`, which owns all state. Extracted so both
 * bodies stay under the max-lines-per-function lint.
 */
function ShareDialogBody({
  level,
  savedLevel,
  canEdit,
  saving,
  grants,
  grantLabels,
  roleOptions,
  groupOptions,
  savedGrantCount,
  livePublication,
  share,
  publishBusy,
  publishError,
  publishPending,
  idOrSlug,
  error,
  pendingApproval,
  onChangeLevel,
  onAddGrant,
  onRemoveGrant,
  onPublish,
  onUnpublish,
  onCancel,
  onSave,
}: {
  level: Level;
  savedLevel: Level;
  canEdit: boolean;
  saving: boolean;
  grants: Grant[];
  grantLabels: Record<string, string>;
  roleOptions: string[];
  groupOptions: GroupOption[];
  /** Grants on the SAVED `group` level — the consequence line counts these. */
  savedGrantCount: number;
  livePublication: LivePublicationState;
  share?: { objectId: string; slug: string; kind: "document" | "artifact" };
  publishBusy: boolean;
  publishError: string | null;
  publishPending: boolean;
  idOrSlug: string;
  error: string | null;
  pendingApproval: string | null;
  onChangeLevel: (level: Level) => void;
  onAddGrant: (grant: Grant) => void;
  onRemoveGrant: (index: number) => void;
  onPublish: () => void;
  onUnpublish: () => void;
  onCancel: () => void;
  onSave: () => void;
}): React.JSX.Element {
  return (
    // `wide` (680px), not the 520px default: this dialog gained two sections
    // (the link row and the Live/Draft row). At 520px the status line wrapped
    // mid-phrase and collided with its Publish/Unpublish buttons.
    <DialogContent className={meridianPortalClassName} data-mer-size="wide">
      <DialogHeader>
        <DialogTitle>Share</DialogTitle>
        <DialogDescription>
          Everything that decides whether a link works: the link itself, who is
          allowed to open it, and whether it is live.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        {/* THE LINK FIRST. Handing someone a URL is what people actually come
            here to do, and showing it above the two settings that govern it is
            what ties the three together. */}
        {share && (
          <ShareLinkSection
            objectId={share.objectId}
            slug={share.slug}
            kind={share.kind}
            isLive={livePublication.live}
            savedLevel={savedLevel}
          />
        )}

        <p className="mer-share-section-label">Who can see it</p>
        <LevelPicker
          level={level}
          disabled={!canEdit || saving}
          onChange={onChangeLevel}
        />

        {level === "group" && (
          <GroupGrantEditor
            grants={grants}
            grantLabels={grantLabels}
            canEdit={canEdit}
            saving={saving}
            roleOptions={roleOptions}
            groupOptions={groupOptions}
            onAdd={onAddGrant}
            onRemove={onRemoveGrant}
          />
        )}

        {share && (
          <>
            <p className="mer-share-section-label">Status</p>
            <SharePublishSection
              isLive={livePublication.live}
              // Only the SAVED level and grants describe what is actually live.
              // An unsaved draft pick has changed nothing on the server, so
              // stating its consequence would describe an audience that does not
              // exist yet.
              visibility={livePublication.loaded ? savedLevel : null}
              grantCount={savedGrantCount}
              busy={publishBusy}
              canEdit={canEdit}
              onPublish={onPublish}
              onUnpublish={onUnpublish}
            />
            {publishError && (
              <p
                className={
                  publishPending
                    ? "text-sm text-amber-600"
                    : "text-sm text-destructive"
                }
                role="status"
              >
                {publishError}
              </p>
            )}
          </>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        {pendingApproval && (
          <p className="text-sm text-amber-600" role="status">
            {pendingApproval}
          </p>
        )}
      </div>

      {canEdit && (
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={onSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      )}
    </DialogContent>
  );
}

/**
 * The topbar trigger. #1336 C5: a labeled SHARE verb, not a bare status badge —
 * the chip was the only entry point to the whole grant machinery and read as a
 * read-only indicator, so nobody found it. The level badge stays beside the
 * label so the current state is still visible at a glance.
 */
function ShareTriggerButton({
  levelKnown,
  loaded,
  canEdit,
  chrome,
}: {
  levelKnown: boolean;
  loaded: boolean;
  canEdit: boolean;
  chrome: LevelChrome;
}): React.JSX.Element {
  return (
    <DialogTrigger asChild>
      <button
        type="button"
        className="mer-ectl"
        data-testid="share-control"
        aria-label={
          levelKnown
            ? `Share — visibility: ${chrome.label}${canEdit ? " (click to edit)" : ""}`
            : loaded
              ? "Visibility unavailable"
              : "Loading visibility…"
        }
        disabled={!loaded}
      >
        <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
        Share
        <ChipBadge levelKnown={levelKnown} chrome={chrome} />
      </button>
    </DialogTrigger>
  );
}

/**
 * The Live/Draft switch's two server calls.
 *
 * Both go through the SAME gated server actions the old Publish ▾ menu used —
 * the permission checks and the approval-queue path live there, not in the UI.
 * Neither call carries visibility any more (#1726): publishing is a state
 * change, so it cannot widen the audience and cannot wipe the author's grants.
 *
 * `onChanged` fires only when publication state actually changed on the server,
 * so the dialog re-reads the live state.
 */
function useSharePublish(idOrSlug: string, onChanged: () => void) {
  const [publishBusy, setPublishBusy] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  /** The last message was a queued approval, not a failure. */
  const [publishPending, setPublishPending] = useState(false);

  const publish = useCallback(
    () => {
      setPublishBusy(true);
      setPublishError(null);
      setPublishPending(false);
      void (async () => {
        try {
          const res = await publishDocumentAction(idOrSlug);
          if (res.isSuccess) {
            onChanged();
          } else {
            // A §26.4 pending-approval outcome is NOT a failure — the publish
            // was queued for an administrator. Surfaced as a notice, not an
            // error, so an author is not told their request failed.
            setPublishError(res.message ?? "Could not publish");
            setPublishPending(Boolean(res.approvalRequired));
          }
        } catch (e) {
          setPublishError(
            e instanceof Error ? e.message : "Could not publish"
          );
        }
        setPublishBusy(false);
      })();
    },
    [idOrSlug, onChanged]
  );

  const unpublish = useCallback(
    () => {
      setPublishBusy(true);
      setPublishError(null);
      setPublishPending(false);
      void (async () => {
        try {
          const res = await unpublishDocumentAction(idOrSlug, {
            destination: LIVE_DESTINATION,
          });
          if (res.isSuccess) {
            onChanged();
          } else {
            setPublishError(res.message ?? "Could not unpublish");
            setPublishPending(Boolean(res.approvalRequired));
          }
        } catch (e) {
          setPublishError(
            e instanceof Error ? e.message : "Could not unpublish"
          );
        }
        setPublishBusy(false);
      })();
    },
    [idOrSlug, onChanged]
  );

  return { publishBusy, publishError, publishPending, publish, unpublish };
}

/**
 * Fold a successful `getVisibilityAction` read into component state.
 *
 * `draftDirty` decides whether the DRAFT is reseeded: a re-read must never
 * clobber an edit in progress, so a dirty draft updates only the "last
 * persisted" baseline that Cancel restores.
 *
 * Extracted from the load effect to keep `VisibilityChip` under the max-lines
 * lint.
 */
function applyLoadedVisibility(
  data: { visibilityLevel: string; grants: unknown[]; grantLabels: Record<string, string>; canEdit: boolean },
  draftDirty: boolean,
  set: {
    setLevel: (v: Level) => void;
    setGrants: (v: Grant[]) => void;
    setSavedLevel: (v: Level) => void;
    setSavedGrants: (v: Grant[]) => void;
    setGrantLabels: (fn: (prev: Record<string, string>) => Record<string, string>) => void;
    setCanEdit: (v: boolean) => void;
    setError: (v: string | null) => void;
    setLevelKnown: (v: boolean) => void;
  }
): void {
  const level = data.visibilityLevel as Level;
  const grants = data.grants as Grant[];
  if (!draftDirty) {
    set.setLevel(level);
    set.setGrants(grants);
  }
  set.setSavedLevel(level);
  set.setSavedGrants(grants);
  // Merge, don't replace: a person just added through the picker has a
  // locally-known label the server has not been told about yet.
  set.setGrantLabels((prev) => ({ ...prev, ...data.grantLabels }));
  set.setCanEdit(data.canEdit);
  set.setError(null);
  set.setLevelKnown(true);
}

export function VisibilityChip({ idOrSlug, share, onChange }: VisibilityChipProps) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // Whether the fetch actually resolved the real level. Distinct from `loaded`:
  // a FAILED fetch is `loaded` (the button is interactive so the user can open
  // the dialog and read the error) but NOT `levelKnown` (so the badge shows the
  // neutral placeholder, never a misleading "Private" lock for a doc whose real
  // level we never learned).
  const [levelKnown, setLevelKnown] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [level, setLevel] = useState<Level>("private");
  const [grants, setGrants] = useState<Grant[]>([]);
  // Display names for `user` grants — see `grantDisplay`.
  const [grantLabels, setGrantLabels] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // §26.4 pending-approval notice — rendered distinctly from `error` (not a failure).
  const [pendingApproval, setPendingApproval] = useState<string | null>(null);
  const [savedLevel, setSavedLevel] = useState<Level>("private");
  const [savedGrants, setSavedGrants] = useState<Grant[]>([]);
  // Bumped every time the dialog opens, so the panel re-reads the PERSISTED
  // state instead of showing what it loaded on mount. Without this the chip goes
  // stale after anything else changes visibility out of band — most obviously
  // #1336's publish-with-widen, which sets the level to Internal/Public from the
  // Publish menu right beside it, leaving the chip insisting "Private".
  const [reloadSeq, setReloadSeq] = useState(0);
  // Whether the user has touched the draft since the dialog opened. A re-read
  // must never clobber an in-progress edit: without this, picking a level
  // immediately after opening is silently reverted the moment the (async)
  // re-read lands. Pristine → the fetch seeds the draft; dirty → it updates only
  // the "last persisted" baseline that Cancel restores.
  const draftDirtyRef = useRef(false);

  // Load the current visibility once per object so the badge shows the real
  // level even before the dialog is opened. The fetch + its setStates run inside
  // the async IIFE (not synchronously in the effect body) to avoid cascading
  // renders; a `cancelled` flag drops a late resolve after the object changes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Reset per-object inside the IIFE (not synchronously in the effect body,
      // which the React Compiler flags): a new id must not show the prior
      // object's chrome while its fetch is in flight.
      setLoaded(false);
      setLevelKnown(false);
      // try/catch/finally so a THROWN fetch (network error, server crash) can
      // never leave `loaded=false` and the trigger button permanently disabled
      // — `setLoaded(true)` always runs in `finally` (guarded by `cancelled`).
      try {
        const result = await getVisibilityAction(idOrSlug);
        if (cancelled) return;
        if (result.isSuccess) {
          applyLoadedVisibility(result.data, draftDirtyRef.current, {
            setLevel,
            setGrants,
            setSavedLevel,
            setSavedGrants,
            setGrantLabels,
            setCanEdit,
            setError,
            setLevelKnown,
          });
        } else {
          // Leave `levelKnown=false` so the badge keeps the neutral placeholder
          // rather than the default "Private" chrome for an unknown level.
          setError(result.message);
        }
      } catch {
        if (cancelled) return;
        setError("Failed to load visibility — please refresh.");
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [idOrSlug, reloadSeq]);

  // Role + group options for the group-grant builder, loaded lazily when the GROUP
  // editor is open. Passing `level === "group"` lets a failed load retry when the
  // user switches the level picker away from group and back (see useGrantOptions).
  const { roles: roleOptions, groups: groupOptions } = useGrantOptions(
    open,
    canEdit,
    level === "group",
    setError
  );

  // Changing the level clears any stale error: a transient `useRoleOptions`
  // failure (or a prior save/validation error) is no longer actionable once the
  // user picks a different level — e.g. switching away from `group` hides the
  // grant builder entirely, so a "couldn't load roles" banner would otherwise
  // linger with nothing the user can do about it. `handleOpenChange` only clears
  // on close, not on level change.
  const changeLevel = useCallback((next: Level) => {
    draftDirtyRef.current = true;
    setLevel(next);
    setError(null);
    setPendingApproval(null);
  }, []);

  const removeGrant = useCallback((index: number) => {
    draftDirtyRef.current = true;
    setGrants((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addGrant = useCallback((grant: Grant, label?: string) => {
    draftDirtyRef.current = true;
    // Skip an exact duplicate (kind+value) — the DB enforces uniqueness anyway.
    setGrants((prev) =>
      prev.some((g) => g.kind === grant.kind && g.value === grant.value)
        ? prev
        : [...prev, grant]
    );
    // Remember the picker's label so the new chip reads as a person straight
    // away, rather than as "user 42" until the dialog is next re-read.
    if (label) {
      setGrantLabels((prev) => ({ ...prev, [`${grant.kind}:${grant.value}`]: label }));
    }
  }, []);

  const save = useCallback(
    async () => {
      await performVisibilitySave(idOrSlug, level, grants, {
        setSaving,
        setError,
        setPendingApproval,
        setSavedLevel,
        setSavedGrants,
        setOpen,
        onChange,
      });
      // The draft IS the persisted state now (or the save failed and the dialog
      // stayed open with the same values) — either way there is nothing a
      // re-read could clobber.
      draftDirtyRef.current = false;
    },
    [idOrSlug, level, grants, onChange]
  );

  // Discard unsaved edits whenever the dialog is dismissed without saving
  // (Esc, outside-click, Dialog X button, or Cancel). Resets draft level/grants
  // to the last-persisted values so the chip never shows unsaved state as saved.
  const handleOpenChange = useCallback((next: boolean) => {
    if (next) {
      // A freshly-opened dialog has no unsaved edits, and re-reads the persisted
      // state (see `reloadSeq`).
      draftDirtyRef.current = false;
      setReloadSeq((n) => n + 1);
    } else {
      draftDirtyRef.current = false;
      setLevel(savedLevel);
      setGrants(savedGrants);
      setError(null);
      setPendingApproval(null);
    }
    setOpen(next);
  }, [savedLevel, savedGrants]);

  const chrome = levelChrome(level);

  // The Public consequence notice reads the SAVED level, not the draft: an
  // unsaved pick of "Public" has changed nothing yet, so promising a live link
  // (or warning about a missing publication) would be premature.
  // Loaded for the WHOLE dialog now, not only the Public notice: the Link
  // section needs to know which reader route actually resolves, and the Publish
  // section needs the live destinations. `pubSeq` re-reads after each
  // publish/unpublish so the section never shows what it loaded on open.
  const [pubSeq, setPubSeq] = useState(0);
  const livePublication = useLivePublication(idOrSlug, open, pubSeq);

  const { publishBusy, publishError, publishPending, publish, unpublish } = useSharePublish(
    idOrSlug,
    () => {
      setPubSeq((n) => n + 1);
      // A publish may have widened visibility in the same transaction, so the
      // audience controls above must re-read too — otherwise the dialog insists
      // "Private" for a doc it just made Public.
      setReloadSeq((n) => n + 1);
    }
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <ShareTriggerButton
        levelKnown={levelKnown}
        loaded={loaded}
        canEdit={canEdit}
        chrome={chrome}
      />
      <ShareDialogBody
        level={level}
        savedLevel={savedLevel}
        canEdit={canEdit}
        saving={saving}
        grants={grants}
        grantLabels={grantLabels}
        roleOptions={roleOptions}
        groupOptions={groupOptions}
        savedGrantCount={savedGrants.length}
        livePublication={livePublication}
        share={share}
        publishBusy={publishBusy}
        publishError={publishError}
        publishPending={publishPending}
        onPublish={publish}
        onUnpublish={unpublish}
        idOrSlug={idOrSlug}
        error={error}
        pendingApproval={pendingApproval}
        onChangeLevel={changeLevel}
        onAddGrant={addGrant}
        onRemoveGrant={removeGrant}
        onCancel={() => handleOpenChange(false)}
        onSave={save}
      />
    </Dialog>
  );
}

interface LevelPickerProps {
  level: Level;
  disabled: boolean;
  onChange: (level: Level) => void;
}

/** The visibility-level select + its one-line help text. */
function LevelPicker({ level, disabled, onChange }: LevelPickerProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="visibility-level">Level</Label>
      <Select
        value={level}
        onValueChange={(v) => onChange(v as Level)}
        disabled={disabled}
      >
        <SelectTrigger id="visibility-level">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className={meridianPortalClassName}>
          {LEVELS.map((l) => (
            <SelectItem key={l.value} value={l.value}>
              {l.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {LEVELS.find((l) => l.value === level)?.help}
      </p>
    </div>
  );
}

interface GroupGrantEditorProps {
  grants: Grant[];
  /**
   * Display labels keyed `${kind}:${value}`, from `getVisibilityAction`. Only
   * `user` grants carry one; everything else is already readable.
   */
  grantLabels: Record<string, string>;
  canEdit: boolean;
  saving: boolean;
  roleOptions: string[];
  groupOptions: GroupOption[];
  /**
   * `label` is the human name for a `user` grant, supplied by the people
   * picker. Passing it through means a just-added person shows as their name
   * immediately instead of as a numeric id until the next server read.
   */
  onAdd: (grant: Grant, label?: string) => void;
  onRemove: (index: number) => void;
}

/**
 * What a grant chip should SAY.
 *
 * A `user` grant stores the numeric users.id, so the chip used to read
 * "user 42" — technically the truth and practically unusable: nobody can
 * verify they shared a page with the right person by reading a primary key.
 *
 * A `user` grant with no resolved label means the account is gone (the grant
 * column is loose text with no FK, so this is a real state). Say so, rather
 * than falling back to the id we were trying to get away from.
 *
 * ## Why labels are held apart from the grants themselves
 *
 * `VisibilityChip` keeps `grantLabels` in its own state rather than folding a
 * name into each `Grant`. The grant list is the thing that gets SAVED, and a
 * display name is not part of that record — merging them would send resolved
 * names back to the write action and risk persisting a stale name as data.
 * The map is also accumulated rather than replaced on each read, so a person
 * just added through the picker keeps their name until the save round-trips.
 */
function grantDisplay(
  grant: Grant,
  labels: Record<string, string>
): { kind: string; value: string } {
  if (grant.kind !== "user") return { kind: grant.kind, value: grant.value };
  const label = labels[`user:${grant.value}`];
  return {
    kind: "person",
    value: label ?? "Account no longer exists",
  };
}

/**
 * The group-grant builder: the current grant chips plus (for editors) a row to
 * add a new grant. Owns its own draft kind/value so the parent's render and
 * save logic stay independent of the in-progress draft.
 */
/**
 * The grant-value control for the currently-picked grant kind: a role select, a
 * synced-group select, the #1336 people picker, or free text. Extracted so
 * `GroupGrantEditor` stays under the max-lines-per-function lint.
 */
function GrantValueField({
  draftKind,
  draftValue,
  onDraftValue,
  saving,
  roleOptions,
  groupOptions,
  onAdd,
  onSubmit,
}: {
  draftKind: GrantKind;
  draftValue: string;
  onDraftValue: (v: string) => void;
  saving: boolean;
  roleOptions: string[];
  groupOptions: GroupOption[];
  /**
   * `label` is the human name for a `user` grant, supplied by the people
   * picker. Passing it through means a just-added person shows as their name
   * immediately instead of as a numeric id until the next server read.
   */
  onAdd: (grant: Grant, label?: string) => void;
  onSubmit: () => void;
}): React.JSX.Element {
  if (draftKind === "role") {
    return (
      <Select value={draftValue} onValueChange={onDraftValue} disabled={saving}>
        <SelectTrigger id="grant-value">
          <SelectValue placeholder="Select a role" />
        </SelectTrigger>
        <SelectContent className={meridianPortalClassName}>
          {roleOptions.map((r) => (
            <SelectItem key={r} value={r}>
              {r}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (draftKind === "group") {
    return (
      <Select value={draftValue} onValueChange={onDraftValue} disabled={saving}>
        <SelectTrigger id="grant-value">
          <SelectValue
            placeholder={
              groupOptions.length === 0 ? "No synced groups" : "Select a group"
            }
          />
        </SelectTrigger>
        <SelectContent className={meridianPortalClassName}>
          {groupOptions.map((g) => (
            <SelectItem key={g.email} value={g.email}>
              {g.name ? `${g.name} (${g.email})` : g.email}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (draftKind === "user") {
    // #1336 C5: search by name/email instead of demanding a raw numeric
    // `users.id`. Selecting a person adds the grant immediately — there is
    // nothing further to type, so routing it through the shared "Add" button
    // would only add a second click.
    return (
      <PeoplePicker
        disabled={saving}
        onSelect={(person) =>
          onAdd(
            { kind: "user", value: String(person.id) },
            person.name?.trim() || person.email
          )
        }
      />
    );
  }
  return (
    <Input
      id="grant-value"
      value={draftValue}
      onChange={(e) => onDraftValue(e.target.value)}
      placeholder={`${draftKind} name`}
      disabled={saving}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit();
        }
      }}
    />
  );
}

function GroupGrantEditor({
  grants,
  grantLabels,
  canEdit,
  saving,
  roleOptions,
  groupOptions,
  onAdd,
  onRemove,
}: GroupGrantEditorProps) {
  const [draftKind, setDraftKind] = useState<GrantKind>("role");
  const [draftValue, setDraftValue] = useState("");

  const submit = useCallback(() => {
    // `group` values are emails (lowercased server-side and here so the local chip
    // matches what is persisted); other kinds keep their case.
    const trimmed = draftValue.trim();
    const value = draftKind === "group" ? trimmed.toLowerCase() : trimmed;
    if (!value) return;
    onAdd({ kind: draftKind, value });
    setDraftValue("");
  }, [draftKind, draftValue, onAdd]);

  return (
    <div className="space-y-2">
      <Label>Group grants</Label>
      {grants.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No grants yet — add at least one below.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {grants.map((g, i) => {
            const shown = grantDisplay(g, grantLabels);
            return (
              <li key={`${g.kind}:${g.value}`}>
                <Badge variant="outline" className="gap-1">
                  <span className="font-medium">{shown.kind}</span>
                  <span className="text-muted-foreground">{shown.value}</span>
                  {canEdit && (
                    <button
                      type="button"
                      aria-label={`Remove ${shown.kind} grant ${shown.value}`}
                      className="ml-0.5 rounded-sm hover:text-destructive"
                      onClick={() => onRemove(i)}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="grant-kind" className="text-xs">
              Kind
            </Label>
            <Select
              value={draftKind}
              onValueChange={(v) => {
                setDraftKind(v as GrantKind);
                setDraftValue("");
              }}
              disabled={saving}
            >
              <SelectTrigger id="grant-kind" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={meridianPortalClassName}>
                {GRANT_KINDS.map((k) => (
                  <SelectItem key={k.value} value={k.value}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex-1 space-y-1">
            <Label htmlFor="grant-value" className="text-xs">
              Value
            </Label>
            <GrantValueField
              draftKind={draftKind}
              draftValue={draftValue}
              onDraftValue={setDraftValue}
              saving={saving}
              roleOptions={roleOptions}
              groupOptions={groupOptions}
              onAdd={onAdd}
              onSubmit={submit}
            />
          </div>

          {/* The people picker adds on selection, so it needs no Add button. */}
          {draftKind !== "user" && (
            <Button
              type="button"
              variant="secondary"
              onClick={submit}
              disabled={saving || !draftValue.trim()}
            >
              Add
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
