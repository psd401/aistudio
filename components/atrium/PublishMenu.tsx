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
 * Presentation only: the action handlers are owned by the parent (they target the
 * resolved object UUID and re-check permission server-side); this only chooses
 * WHICH destination they act on. The dropdown content portals to document.body,
 * so it carries `meridianPortalClassName` to render Meridian (not global cream).
 *
 * Destination semantics (unchanged from the prior toolbar):
 * - `intranet` (default) — the internal reader; never trips the §26.4 gate.
 * - `public_web` — the §26.4 public destination; a caller without public-publish
 *   authority gets the amber pending-approval outcome.
 * - `schoology` / `google` — visible but DISABLED ("coming soon"): governed
 *   connector stubs that throw `implemented: false`.
 */

import { useState } from "react";
import { ChevronDown, Globe, Building2, GraduationCap, Upload } from "lucide-react";
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
import { meridianPortalClassName } from "@/lib/atrium/meridian-fonts";
import type { EditorPublishDestination } from "@/actions/db/atrium/publish-document";

/** The picker's options — the editor-publishable destinations, in menu order. */
const DESTINATION_OPTIONS: ReadonlyArray<{
  value: EditorPublishDestination;
  label: string;
  short: string;
  icon: React.ReactNode;
  disabled?: boolean;
}> = [
  {
    value: "intranet",
    label: "Intranet",
    short: "intranet",
    icon: <Building2 className="h-3.5 w-3.5" aria-hidden="true" />,
  },
  {
    value: "public_web",
    label: "Public web — may require approval",
    short: "public web",
    icon: <Globe className="h-3.5 w-3.5" aria-hidden="true" />,
  },
  {
    value: "schoology",
    label: "Schoology (coming soon)",
    short: "Schoology",
    icon: <GraduationCap className="h-3.5 w-3.5" aria-hidden="true" />,
    disabled: true,
  },
  {
    value: "google",
    label: "Google (coming soon)",
    short: "Google",
    icon: <Upload className="h-3.5 w-3.5" aria-hidden="true" />,
    disabled: true,
  },
];

interface PublishMenuProps {
  /** An edit action is in flight — disables the trigger + items. */
  busy: boolean;
  onSnapshot: () => void;
  onPublish: (destination: EditorPublishDestination) => void;
  onUnpublish: (destination: EditorPublishDestination) => void;
}

export function PublishMenu({
  busy,
  onSnapshot,
  onPublish,
  onUnpublish,
}: PublishMenuProps): React.JSX.Element {
  // The picked destination drives BOTH Publish and Unpublish (one control, as the
  // spec asked). Disabled options can't be picked, so this is always a live
  // destination; intranet is the default.
  const [destination, setDestination] =
    useState<EditorPublishDestination>("intranet");
  const current =
    DESTINATION_OPTIONS.find((o) => o.value === destination) ??
    DESTINATION_OPTIONS[0];

  return (
    <DropdownMenu>
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
              disabled={o.disabled}
              className="gap-2"
              // Keep the menu OPEN when picking a destination (Radix closes it by
              // default on select) so the user can then click Publish/Unpublish in
              // the same dropdown without reopening it.
              onSelect={(e) => e.preventDefault()}
            >
              {o.icon}
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onSelect={() => onPublish(destination)}>
          Publish to {current.short}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={busy}
          onSelect={() => onUnpublish(destination)}
          className="text-destructive focus:text-destructive"
        >
          Unpublish from {current.short}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onSelect={onSnapshot}>
          Save a version
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
