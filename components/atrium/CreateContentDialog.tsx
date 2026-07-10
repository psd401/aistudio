"use client";

/**
 * Atrium CreateContentDialog — "New doc / New artifact" creation (Issue #1054).
 *
 * Collects a title and delegates creation to the parent's `onCreate`, which calls
 * `createContentAction` (server-side `canCreate` + capability gate) and navigates
 * to the editor on success. Returns an error string for the dialog to show, or
 * null on success. Focus is moved to the title input on open via a ref (avoiding
 * the `autoFocus` prop, which the a11y lint flags).
 *
 * The parent gives this component a `key` of the current kind, so each open is a
 * FRESH mount — initial `title`/`error` state without a reset-in-effect (which the
 * react-hooks lint flags as a cascading render).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ContentKind } from "@/lib/content";

interface CreateContentDialogProps {
  /** The kind being created, or null when the dialog is closed. */
  kind: ContentKind | null;
  onClose: () => void;
  /** Returns an error message to display, or null on success (navigates away). */
  onCreate: (title: string) => Promise<string | null>;
}

export function CreateContentDialog({
  kind,
  onClose,
  onCreate,
}: CreateContentDialogProps): React.JSX.Element {
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const open = kind !== null;

  // Focus the title input when the dialog opens. No state reset here — the parent
  // remounts this component per kind via `key`, so `title`/`error` already start
  // fresh (avoids the cascading-render lint on setState-in-effect).
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const submit = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError("Title is required");
      return;
    }
    setCreating(true);
    setError(null);
    const message = await onCreate(trimmed);
    // On success the parent navigates away; on failure show the message.
    if (message) {
      setError(message);
      setCreating(false);
    }
  }, [title, onCreate]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            New {kind === "artifact" ? "artifact" : "doc"}
          </DialogTitle>
          <DialogDescription>
            {kind === "artifact"
              ? "Create an interactive artifact. You can edit and preview it next."
              : "Create a document. You'll edit it in the live editor next."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="new-content-title">Title</Label>
          <Input
            id="new-content-title"
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Untitled"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !creating) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={creating}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={creating}>
            {creating && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
