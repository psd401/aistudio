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
import { meridianPortalClassName } from "@/lib/meridian/fonts";

interface AgentCreateDialogProps {
  /** Whether the prompt surface is open. */
  open: boolean;
  onClose: () => void;
  /**
   * Submit the agent prompt. Returns an error message to display, or null on
   * success (the caller navigates to the new artifact's workspace).
   */
  onSubmit: (prompt: string) => Promise<string | null>;
  /**
   * Create an EMPTY interactive page and open it in the editor, skipping the
   * agent entirely. Optional so surfaces that only offer the agent path can omit
   * it — but the library passes it, because "describe it to a chatbot" was the
   * only way in and that is not how everyone wants to start.
   *
   * Same contract as `onSubmit`: resolves to an error message to display, or
   * null on success (the caller navigates away).
   */
  onStartBlank?: () => Promise<string | null>;
}

/** A few starter prompts, so an empty field is never a blank wall. */
const EXAMPLE_PROMPTS: ReadonlyArray<string> = [
  "A dashboard summarizing our enrollment trends by school",
  "An interactive FAQ for the new bell schedule",
  "A one-page budget explainer with a donut chart",
];

/** The two create paths the dialog offers; `null` when neither is in flight. */
type CreatePath = "agent" | "blank";

export function CreateContentDialog({
  open,
  onClose,
  onSubmit,
  onStartBlank,
}: AgentCreateDialogProps): React.JSX.Element {
  const [prompt, setPrompt] = useState("");
  // Which create path is in flight, so the button that was clicked is the one
  // that spins. A disabled-but-static "Start blank" gave no sign the click
  // registered, which is how the original failure looked like a no-op (#1714).
  const [creating, setCreating] = useState<CreatePath | null>(null);
  const busy = creating !== null;
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Focus the prompt field when the surface opens. No state reset here — the
  // parent remounts this via `key`, so `prompt`/`error` already start fresh.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  /**
   * Shared busy/error lifecycle for both create paths.
   *
   * The `try/catch` is load-bearing: a server action that never reaches the app
   * — e.g. one blocked at the edge by the WAF, whose HTML 403 body is not a
   * valid action response — REJECTS instead of resolving to an error string.
   * Without catching it, `creating` stayed set and the button spun forever
   * (#1714). On success the parent navigates away, so `creating` is
   * deliberately left set to keep the buttons disabled through the navigation.
   */
  const runCreate = useCallback(
    async (path: CreatePath, run: () => Promise<string | null>) => {
      setCreating(path);
      setError(null);
      let message: string | null;
      try {
        message = await run();
      } catch {
        message = "Something went wrong. Please try again.";
      }
      if (message) {
        setError(message);
        setCreating(null);
      }
    },
    []
  );

  const submit = useCallback(async () => {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setError("Describe what you'd like the agent to build.");
      return;
    }
    await runCreate("agent", () => onSubmit(trimmed));
  }, [prompt, onSubmit, runCreate]);

  const startBlank = useCallback(async () => {
    if (!onStartBlank) return;
    await runCreate("blank", onStartBlank);
  }, [onStartBlank, runCreate]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className={meridianPortalClassName}>
        <DialogHeader>
          <DialogTitle>New interactive page</DialogTitle>
          <DialogDescription>
            An interactive page is a real web page — charts, calculators,
            dashboards — that lives in your library like a document does.
            Describe what you want and the agent builds it{" "}
            <strong>in the chat</strong>, with a live preview beside it. You can
            also start from an empty page and write the HTML yourself.
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
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !busy) {
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
                disabled={busy}
                onClick={() => setPrompt(ex)}
              >
                {ex}
              </button>
            ))}
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <button
            type="button"
            className="mer-btn"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          {onStartBlank && (
            <button
              type="button"
              className="mer-btn"
              onClick={() => void startBlank()}
              disabled={busy}
            >
              {creating === "blank" && (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              )}
              Start blank
            </button>
          )}
          <button
            type="button"
            className="mer-btn mer-btn-agent"
            onClick={() => void submit()}
            disabled={busy}
          >
            {creating === "agent" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            )}
            Build it for me
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
