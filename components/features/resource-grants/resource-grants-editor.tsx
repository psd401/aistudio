"use client";

/**
 * ResourceGrantsEditor — the admin per-resource access editor (Epic #1202 Phase
 * 3, #1206). Shared across the model, assistant, and skill admin surfaces.
 *
 * A resource with NO grants is UNRESTRICTED (available to everyone); adding any
 * role or group grant restricts it to holders of that role / members of that
 * group (administrators always retain access, enforced server-side). This editor
 * only manages the grant rows; enforcement is in lib/db/drizzle/resource-access.ts.
 *
 * State + persistence live in useResourceGrants; `ResourceGrantsDialog` wraps the
 * editor in a button + dialog for per-row table surfaces.
 */

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { MultiSelect, type MultiSelectOption } from "@/components/ui/multi-select";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { IconLock, IconLockOpen, IconLoader2 } from "@tabler/icons-react";
import { useResourceGrants, type ResourceType } from "./use-resource-grants";

interface ResourceGrantsEditorProps {
  resourceType: ResourceType;
  resourceId: number | string;
  /** Optional resource name for context in the header. */
  resourceLabel?: string;
  /** Called after a successful save (e.g. to close a dialog). */
  onSaved?: () => void;
}

export function ResourceGrantsEditor({
  resourceType,
  resourceId,
  resourceLabel,
  onSaved,
}: ResourceGrantsEditorProps) {
  const g = useResourceGrants(resourceType, resourceId, onSaved);

  const roleOptions: MultiSelectOption[] = useMemo(
    () => g.options.roles.map((r) => ({ value: r, label: r })),
    [g.options.roles]
  );
  const groupOptions: MultiSelectOption[] = useMemo(
    () => g.options.groups.map((grp) => ({ value: grp.email, label: grp.name || grp.email })),
    [g.options.groups]
  );

  if (g.loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <IconLoader2 className="h-4 w-4 animate-spin" /> Loading access…
      </div>
    );
  }

  if (g.error) {
    return (
      <div className="space-y-3 py-4">
        <p className="text-sm text-destructive">{g.error}</p>
        <Button variant="outline" size="sm" onClick={g.reload}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {g.isUnrestricted ? (
          <Badge variant="secondary" className="gap-1">
            <IconLockOpen className="h-3.5 w-3.5" /> Unrestricted
          </Badge>
        ) : (
          <Badge variant="default" className="gap-1">
            <IconLock className="h-3.5 w-3.5" /> Restricted
          </Badge>
        )}
        <span className="text-xs text-muted-foreground">
          {g.isUnrestricted
            ? "Available to everyone. Add a role or group to restrict access."
            : "Only the selected roles / groups (and administrators) can access this."}
        </span>
      </div>

      <div className="space-y-2">
        <Label>Roles</Label>
        <MultiSelect
          options={roleOptions}
          value={g.roleValues}
          onChange={g.setRoleValues}
          placeholder="Select roles…"
          allowCustom
          customPlaceholder="Add a role name…"
          className="w-full"
        />
      </div>

      <div className="space-y-2">
        <Label>Google groups</Label>
        <MultiSelect
          options={groupOptions}
          value={g.groupValues}
          onChange={g.setGroupValues}
          placeholder="Select groups…"
          allowCustom
          customPlaceholder="Add a group email…"
          className="w-full"
        />
      </div>

      <div className="flex items-center justify-end gap-2 pt-2">
        <Button variant="ghost" size="sm" disabled={!g.isDirty || g.saving} onClick={g.reset}>
          Reset
        </Button>
        <Button size="sm" onClick={() => void g.save()} disabled={!g.isDirty || g.saving}>
          {g.saving ? <IconLoader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Save access
        </Button>
      </div>
      {resourceLabel ? <p className="sr-only">Editing access for {resourceLabel}</p> : null}
    </div>
  );
}

interface ResourceGrantsDialogProps extends ResourceGrantsEditorProps {
  /** Trigger button label. */
  triggerLabel?: string;
  /** Render a custom trigger instead of the default button. */
  trigger?: React.ReactNode;
}

/**
 * Button + dialog wrapper around ResourceGrantsEditor for per-row admin table
 * surfaces (models, assistants, skills). The editor loads on open (keyed to the
 * resource) and closes itself after a successful save.
 */
export function ResourceGrantsDialog({
  triggerLabel = "Manage access",
  trigger,
  resourceType,
  resourceId,
  resourceLabel,
  onSaved,
}: ResourceGrantsDialogProps) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant="outline" size="sm" className="gap-1">
            <IconLock className="h-3.5 w-3.5" /> {triggerLabel}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Manage access</DialogTitle>
          <DialogDescription>
            {resourceLabel
              ? `Control who can access "${resourceLabel}".`
              : "Control who can access this resource."}
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <ResourceGrantsEditor
            resourceType={resourceType}
            resourceId={resourceId}
            resourceLabel={resourceLabel}
            onSaved={() => {
              onSaved?.();
              setOpen(false);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
