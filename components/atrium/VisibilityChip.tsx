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

const POSITIVE_INT_RE = /^[1-9][0-9]*$/;

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
    default:
      return { variant: "ghost", icon: <Lock className="h-3 w-3" />, label: "Private" };
  }
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

export function VisibilityChip({ idOrSlug, onChange }: VisibilityChipProps) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [level, setLevel] = useState<Level>("private");
  const [grants, setGrants] = useState<Grant[]>([]);
  const [roleOptions, setRoleOptions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the current visibility once per object so the badge shows the real
  // level even before the dialog is opened. The fetch + its setStates run inside
  // the async IIFE (not synchronously in the effect body) to avoid cascading
  // renders; a `cancelled` flag drops a late resolve after the object changes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await getVisibilityAction(idOrSlug);
      if (cancelled) return;
      if (result.isSuccess) {
        const loadedLevel = result.data.visibilityLevel as Level;
        const loadedGrants = result.data.grants as Grant[];
        setLevel(loadedLevel);
        setGrants(loadedGrants);
        savedLevelRef.current = loadedLevel;
        savedGrantsRef.current = loadedGrants;
        setCanEdit(result.data.canEdit);
        setError(null);
      } else {
        setError(result.message);
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [idOrSlug]);

  // Lazily load role options the first time the editor opens (only an editor
  // building a group grant needs them). A ref guards against a re-fetch after a
  // successful load even though `roleOptions.length` is intentionally NOT a dep
  // (depending on it would re-run the effect on every option-list change).
  const roleOptionsLoaded = useRef(false);
  const savedLevelRef = useRef<Level>("private");
  const savedGrantsRef = useRef<Grant[]>([]);
  useEffect(() => {
    if (!open || !canEdit || roleOptionsLoaded.current) return;
    let cancelled = false;
    void (async () => {
      const result = await listGrantOptionsAction();
      if (cancelled) return;
      if (result.isSuccess) {
        roleOptionsLoaded.current = true;
        setRoleOptions(result.data.roles);
      } else {
        // Surface the failure so the user knows why the role dropdown is empty,
        // rather than silently leaving them with zero role options.
        setError(result.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, canEdit]);

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

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    // A group object with no grants is visible to no one but the owner/admin —
    // block the save client-side with a clear message (the service also rejects).
    if (level === "group" && grants.length === 0) {
      setError("Group visibility needs at least one grant.");
      setSaving(false);
      return;
    }
    const result = await setVisibilityAction(idOrSlug, {
      level,
      // Grants are only sent for `group`; other levels clear them server-side.
      grants: level === "group" ? grants : [],
    });
    setSaving(false);
    if (result.isSuccess) {
      const newLevel = result.data.visibilityLevel as Level;
      savedLevelRef.current = newLevel;
      savedGrantsRef.current = level === "group" ? grants : [];
      setOpen(false);
      onChange?.(newLevel);
    } else {
      setError(result.message);
    }
  }, [idOrSlug, level, grants, onChange]);

  // Discard unsaved edits whenever the dialog is dismissed without saving
  // (Esc, outside-click, Dialog X button, or Cancel). Resets draft level/grants
  // to the last-persisted values so the chip never shows unsaved state as saved.
  const handleOpenChange = useCallback((next: boolean) => {
    if (!next) {
      setLevel(savedLevelRef.current);
      setGrants(savedGrantsRef.current);
      setError(null);
    }
    setOpen(next);
  }, []);

  const chrome = levelChrome(level);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex"
          aria-label={`Visibility: ${chrome.label}${canEdit ? " (click to edit)" : ""}`}
          disabled={!loaded}
        >
          <Badge variant={chrome.variant} className="gap-1 cursor-pointer">
            {chrome.icon}
            {chrome.label}
          </Badge>
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
            onChange={setLevel}
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
