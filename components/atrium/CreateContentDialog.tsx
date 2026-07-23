"use client";

/**
 * Atrium AgentCreateDialog — "Create with the agent" prompt surface (Epic #1059
 * redesign; README Interactions: creation is a PROMPT, not a form).
 *
 * The Meridian creation flow splits by kind:
 *  - "New doc" opens a blank sheet IMMEDIATELY (no modal) — handled in
 *    `LibraryView` by creating an untitled document and navigating to its editor.
 *  - "New artifact" / the dashed "Create with the agent" card open THIS single
 *    prompt field. The caller (`LibraryView`) creates the artifact and deep-links
 *    into the Nexus workspace chat with the prompt prefilled, so the agent builds
 *    the artifact beside its live preview (the §17 `?workspace=` machinery).
 *
 * Presentation only: it collects one free-text description and delegates to
 * `onSubmit`, which returns an error string to show, or null on success (the
 * caller navigates away). Focus moves to the field on open via a ref (not the
 * `autoFocus` prop, which the a11y lint flags). The parent gives this a `key` so
 * each open is a FRESH mount — initial state without a reset-in-effect.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { meridianPortalClassName } from "@/lib/atrium/meridian-fonts";

interface AgentCreateDialogProps {
  /** Whether the prompt surface is open. */
  open: boolean;
  onClose: () => void;
  /**
   * Submit the agent prompt. Returns an error message to display, or null on
   * success (the caller navigates to the new artifact's workspace).
   */
  onSubmit: (prompt: string) => Promise<string | null>;
}

/** A few starter prompts, so an empty field is never a blank wall. */
const EXAMPLE_PROMPTS: ReadonlyArray<string> = [
  "A dashboard summarizing our enrollment trends by school",
  "An interactive FAQ for the new bell schedule",
  "A one-page budget explainer with a donut chart",
];

export function CreateContentDialog({
  open,
  onClose,
  onSubmit,
}: AgentCreateDialogProps): React.JSX.Element {
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Focus the prompt field when the surface opens. No state reset here — the
  // parent remounts this via `key`, so `prompt`/`error` already start fresh.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const submit = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError("Describe what you'd like the agent to build.");
      return;
    }
    setCreating(true);
    setError(null);
    const message = await onSubmit(trimmed);
    // On success the parent navigates away; on failure show the message.
    if (message) {
      setError(message);
      setCreating(false);
    }
  }, [prompt, onSubmit]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className={meridianPortalClassName}>
        <DialogHeader>
          <DialogTitle>Create with the agent</DialogTitle>
          <DialogDescription>
            Describe what you want — the agent drafts the artifact and opens it
            beside the chat so you can refine it together.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <textarea
            ref={inputRef}
            className="mer-prompt-field"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. An interactive attendance dashboard for our leadership team…"
            rows={4}
            aria-label="Describe the artifact for the agent to build"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !creating) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="mer-prompt-examples">
            {EXAMPLE_PROMPTS.map((ex) => (
              <button
                key={ex}
                type="button"
                className="mer-prompt-example"
                disabled={creating}
                onClick={() => setPrompt(ex)}
              >
                {ex}
              </button>
            ))}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <button
            type="button"
            className="mer-btn"
            onClick={onClose}
            disabled={creating}
          >
            Cancel
          </button>
          <button
            type="button"
            className="mer-btn mer-btn-agent"
            onClick={() => void submit()}
            disabled={creating}
          >
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            )}
            Create with the agent
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
