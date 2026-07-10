"use client";

/**
 * Nexus workspace panel (Epic #1059, spec §17) — edit Atrium content BESIDE the chat.
 *
 * Mounted by the Nexus page as a pure LAYOUT SIBLING of the conversation tree,
 * keyed on the `?workspace=<id|slug>` URL param. It deliberately touches NO
 * conversation state (no runtime, no conversation id, no assistant-ui context) —
 * the fragile Nexus streaming architecture (see
 * docs/features/nexus-conversation-architecture.md) is completely unaware of it.
 * "Re-prompt via adjacent chat" is exactly that: the chat sits beside this panel,
 * so tweaking agent-drafted content is typing in the chat the user already has.
 *
 * The panel loads one canView-gated payload (`loadWorkspacePanelAction`, which
 * 404-masks like the standalone edit page) and mounts the SAME kind-specific
 * editors the full page uses — `DocumentEditor` (live collaborative editor) or
 * `ArtifactCanvas` (Preview|Code + cross-origin sandbox). No editor logic is
 * duplicated; the full-page experience stays one click away.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { X, ExternalLink } from "lucide-react";
import {
  loadWorkspacePanelAction,
  type WorkspacePanelData,
} from "@/actions/db/atrium/workspace-panel";
import { DocumentEditor } from "./DocumentEditor";
import { ArtifactCanvas } from "./ArtifactCanvas";

export interface WorkspacePanelProps {
  /** Content object id or slug (the `?workspace=` param). */
  idOrSlug: string;
  /** Close the panel (the mount clears the URL param). */
  onClose: () => void;
}

type PanelState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: WorkspacePanelData };

export function WorkspacePanel({ idOrSlug, onClose }: WorkspacePanelProps) {
  const [state, setState] = useState<PanelState>({ status: "loading" });
  // ID change → reset to loading DURING RENDER (React's derived-state pattern —
  // a synchronous setState inside the effect would trigger cascading renders).
  // The effect below then loads exactly once per id ([idOrSlug] dep) with a
  // cancelled flag so a stale response never lands on a newer id's panel.
  const [loadedFor, setLoadedFor] = useState(idOrSlug);
  if (loadedFor !== idOrSlug) {
    setLoadedFor(idOrSlug);
    setState({ status: "loading" });
  }

  useEffect(() => {
    let cancelled = false;
    void loadWorkspacePanelAction(idOrSlug).then((result) => {
      if (cancelled) return;
      if (result.isSuccess) {
        setState({ status: "ready", data: result.data });
      } else {
        setState({
          status: "error",
          message: result.message ?? "This item could not be opened.",
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [idOrSlug]);

  return (
    <aside
      // Desktop-only split: below md the 380px minimum + the chat column would
      // force horizontal overflow, so the panel hides and the full-page editor
      // (one click away) is the small-screen path.
      className="hidden h-full w-[44%] min-w-[380px] max-w-[720px] flex-col border-l bg-background md:flex"
      aria-label="Workspace"
      data-testid="workspace-panel"
    >
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <h2 className="truncate text-sm font-medium">
          {state.status === "ready" ? state.data.title : "Workspace"}
        </h2>
        <div className="flex shrink-0 items-center gap-1">
          {state.status === "ready" && (
            <Link
              href={`/atrium/${state.data.id}/edit`}
              title="Open full page"
              className="rounded p-1.5 text-muted-foreground hover:bg-accent"
            >
              <ExternalLink className="h-4 w-4" />
              <span className="sr-only">Open full page</span>
            </Link>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Close workspace"
            data-testid="workspace-close"
            className="rounded p-1.5 text-muted-foreground hover:bg-accent"
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close workspace</span>
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {state.status === "loading" && (
          <p className="p-4 text-sm text-muted-foreground">Loading workspace…</p>
        )}
        {state.status === "error" && (
          <p role="alert" className="p-4 text-sm text-destructive">
            {state.message}
          </p>
        )}
        {state.status === "ready" &&
          (state.data.kind === "document" ? (
            <DocumentEditor
              idOrSlug={state.data.id}
              userId={state.data.userId}
              layout="panel"
            />
          ) : (
            <ArtifactCanvas
              idOrSlug={state.data.id}
              canEdit={state.data.canEdit}
              sandboxSrc={state.data.sandboxSrc}
            />
          ))}
      </div>
    </aside>
  );
}
