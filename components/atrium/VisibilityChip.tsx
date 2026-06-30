"use client";

/**
 * Atrium VisibilityChip + visibility editor (#1053, Epic #1059, spec §12 / §17)
 *
 * The shared panel-header control that shows an object's current visibility level
 * and opens the visibility editor: a level picker (private / group / internal /
 * public) plus a group-grant builder (role / building / department / grade / user
 * grants). It reads the current state via `getVisibilityAction` and persists via
 * `setVisibilityAction` — both of which run the `canView` + `assertCanEdit` gates
 * server-side, so this UI is presentation only (no authorization logic here).
 *
 * Grant value semantics (mirror visibility-service §12.2):
 * - role        — a role NAME (selected from the role list), matched against the
 *                 viewer's roles.
 * - building / department / grade — a free-form `users` attribute string.
 * - user        — a numeric `users.id`.
 *
 * For a viewer who cannot edit (not owner/admin), the chip renders read-only:
 * the badge shows the level, the dialog's controls are disabled, and Save is
 * hidden. The server re-checks edit permission regardless.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Globe, Lock, Users, Building2, X } from "lucide-react";
import { getVisibilityAction } from "@/actions/db/atrium/get-visibility";
import { setVisibilityAction } from "@/actions/db/atrium/set-visibility";
import { listGrantOptionsAction } from "@/actions/db/atrium/list-grant-options";
import { POSITIVE_INT_RE } from "@/lib/content/validators";

/** The visibility levels, in widening order, with their picker labels. */
const LEVELS = [
  { value: "private", label: "Private", help: "Only you (and admins)." },
  { value: "group", label: "Group", help: "Specific roles, buildings, departments, grades, or people." },
  { value: "internal", label: "Internal", help: "Any signed-in user." },
  { value: "public", label: "Public", help: "Anyone, including signed-out visitors." },
] as const;
type Level = (typeof LEVELS)[number]["value"];

const GRANT_KINDS = [
  { value: "role", label: "Role" },
  { value: "building", label: "Building" },
  { value: "department", label: "Department" },
  { value: "grade", label: "Grade" },
  { value: "user", label: "User ID" },
] as const;
type GrantKind = (typeof GRANT_KINDS)[number]["value"];

interface Grant {
  kind: GrantKind;
  value: string;
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
   * Called after a successful save with the new level, so a parent can reflect
   * it without re-fetching (the chip already updates its own badge).
   */
  onChange?: (level: Level) => void;
}

/**
 * Lazily load the role options the first time the editor opens for an editor (only
 * an editor building a group grant needs them). A boolean ref guards against a
 * re-fetch after a successful load even though `roles.length` is intentionally NOT
 * a dep (depending on it would re-run the effect on every option-list change).
 *
 * NOTE: a boolean ref is correct HERE (unlike the parameterized-route anti-pattern
 * in CLAUDE.md) because the role list is GLOBAL — it does not depend on `idOrSlug`
 * or any other prop, so it never needs to reset for a different id. The parent
 * additionally keys `VisibilityChip` on `obj.id`, so the whole component (and this
 * ref) remounts on navigation regardless. Extracted from the component to keep its
 * body under the max-lines lint cap and to isolate the fetch lifecycle.
 */
function useRoleOptions(
  open: boolean,
  canEdit: boolean,
  onError: (message: string) => void
): string[] {
  const [roleOptions, setRoleOptions] = useState<string[]>([]);
  const roleOptionsLoaded = useRef(false);
  useEffect(() => {
    if (!open || !canEdit || roleOptionsLoaded.current) return;
    let cancelled = false;
    void (async () => {
      // try/catch so a THROWN fetch (network error) still surfaces an error
      // rather than silently leaving the role dropdown empty with no explanation.
      try {
        const result = await listGrantOptionsAction();
        if (cancelled) return;
        if (result.isSuccess) {
          roleOptionsLoaded.current = true;
          setRoleOptions(result.data.roles);
        } else {
          // Surface the failure so the user knows why the role dropdown is empty,
          // rather than silently leaving them with zero role options.
          onError(result.message);
        }
      } catch {
        if (!cancelled) {
          onError("Failed to load role options — please close and reopen.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, canEdit, onError]);
  return roleOptions;
}

/**
 * Mirror the server's grant reconciliation so the chip's local `savedGrants` never
 * diverges from what was actually persisted: group keeps all supplied grants,
 * private PRESERVES `user`-kind grants (both read paths honor them), internal/public
 * clear everything. Values are trimmed and (kind,value)-deduped to match the
 * server's `applyGrantsInTx` normalization — otherwise a later Cancel would restore
 * un-trimmed draft values as the "last persisted" state.
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
    const value = g.value.trim();
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
    setSavedLevel: (v: Level) => void;
    setSavedGrants: (v: Grant[]) => void;
    setOpen: (v: boolean) => void;
    onChange?: (level: Level) => void;
  }
): Promise<void> {
  const { setSaving, setError, setSavedLevel, setSavedGrants, setOpen, onChange } =
    setters;
  setSaving(true);
  setError(null);
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
    } else {
      setError(result.message);
    }
  } catch {
    setError("Failed to save — please try again.");
  } finally {
    setSaving(false);
  }
}

export function VisibilityChip({ idOrSlug, onChange }: VisibilityChipProps) {
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedLevel, setSavedLevel] = useState<Level>("private");
  const [savedGrants, setSavedGrants] = useState<Grant[]>([]);

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
          const loadedLevel = result.data.visibilityLevel as Level;
          const loadedGrants = result.data.grants as Grant[];
          setLevel(loadedLevel);
          setGrants(loadedGrants);
          setSavedLevel(loadedLevel);
          setSavedGrants(loadedGrants);
          setCanEdit(result.data.canEdit);
          setError(null);
          setLevelKnown(true);
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
  }, [idOrSlug]);

  // Role options for the group-grant builder, loaded lazily on first editor open.
  const roleOptions = useRoleOptions(open, canEdit, setError);

  // Changing the level clears any stale error: a transient `useRoleOptions`
  // failure (or a prior save/validation error) is no longer actionable once the
  // user picks a different level — e.g. switching away from `group` hides the
  // grant builder entirely, so a "couldn't load roles" banner would otherwise
  // linger with nothing the user can do about it. `handleOpenChange` only clears
  // on close, not on level change.
  const changeLevel = useCallback((next: Level) => {
    setLevel(next);
    setError(null);
  }, []);

  const removeGrant = useCallback((index: number) => {
    setGrants((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addGrant = useCallback((grant: Grant) => {
    // Skip an exact duplicate (kind+value) — the DB enforces uniqueness anyway.
    setGrants((prev) =>
      prev.some((g) => g.kind === grant.kind && g.value === grant.value)
        ? prev
        : [...prev, grant]
    );
  }, []);

  const save = useCallback(
    () =>
      performVisibilitySave(idOrSlug, level, grants, {
        setSaving,
        setError,
        setSavedLevel,
        setSavedGrants,
        setOpen,
        onChange,
      }),
    [idOrSlug, level, grants, onChange]
  );

  // Discard unsaved edits whenever the dialog is dismissed without saving
  // (Esc, outside-click, Dialog X button, or Cancel). Resets draft level/grants
  // to the last-persisted values so the chip never shows unsaved state as saved.
  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) {
      setLevel(savedLevel);
      setGrants(savedGrants);
      setError(null);
    }
    setOpen(next);
  }, [savedLevel, savedGrants]);

  const chrome = levelChrome(level);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex"
          aria-label={
            levelKnown
              ? `Visibility: ${chrome.label}${canEdit ? " (click to edit)" : ""}`
              : loaded
                ? "Visibility unavailable"
                : "Loading visibility…"
          }
          disabled={!loaded}
        >
          <ChipBadge levelKnown={levelKnown} chrome={chrome} />
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Visibility</DialogTitle>
          <DialogDescription>
            Controls who may view this content. Separate from where it is
            published.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <LevelPicker
            level={level}
            disabled={!canEdit || saving}
            onChange={changeLevel}
          />

          {level === "group" && (
            <GroupGrantEditor
              grants={grants}
              canEdit={canEdit}
              saving={saving}
              roleOptions={roleOptions}
              onAdd={addGrant}
              onRemove={removeGrant}
            />
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        {canEdit && (
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="button" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
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
        <SelectContent>
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
  canEdit: boolean;
  saving: boolean;
  roleOptions: string[];
  onAdd: (grant: Grant) => void;
  onRemove: (index: number) => void;
}

/**
 * The group-grant builder: the current grant chips plus (for editors) a row to
 * add a new grant. Owns its own draft kind/value so the parent's render and
 * save logic stay independent of the in-progress draft.
 */
function GroupGrantEditor({
  grants,
  canEdit,
  saving,
  roleOptions,
  onAdd,
  onRemove,
}: GroupGrantEditorProps) {
  const [draftKind, setDraftKind] = useState<GrantKind>("role");
  const [draftValue, setDraftValue] = useState("");

  const submit = useCallback(() => {
    const value = draftValue.trim();
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
          {grants.map((g, i) => (
            <li key={`${g.kind}:${g.value}`}>
              <Badge variant="outline" className="gap-1">
                <span className="font-medium">{g.kind}</span>
                <span className="text-muted-foreground">{g.value}</span>
                {canEdit && (
                  <button
                    type="button"
                    aria-label={`Remove ${g.kind} grant ${g.value}`}
                    className="ml-0.5 rounded-sm hover:text-destructive"
                    onClick={() => onRemove(i)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </Badge>
            </li>
          ))}
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
              <SelectContent>
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
            {draftKind === "role" ? (
              <Select
                value={draftValue}
                onValueChange={setDraftValue}
                disabled={saving}
              >
                <SelectTrigger id="grant-value">
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  {roleOptions.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="grant-value"
                value={draftValue}
                onChange={(e) => setDraftValue(e.target.value)}
                placeholder={
                  draftKind === "user" ? "Numeric user ID" : `${draftKind} name`
                }
                inputMode={draftKind === "user" ? "numeric" : "text"}
                disabled={saving}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
            )}
          </div>

          <Button
            type="button"
            variant="secondary"
            onClick={submit}
            disabled={
              saving ||
              !draftValue.trim() ||
              (draftKind === "user" && !POSITIVE_INT_RE.test(draftValue.trim()))
            }
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
