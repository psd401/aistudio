"use client";

/**
 * Atrium document editor (#1051)
 *
 * The live, real-time collaborative editor — the rebuilt Proof surface. TipTap on
 * ProseMirror + Yjs, synced through a WebsocketProvider to the Atrium collab
 * server, with the green/purple provenance rail and human-edit attribution.
 *
 * Flow: fetch a per-document collab token (GET /api/content/[id]/collab) → open a
 * WebsocketProvider bound to a Y.Doc → TipTap's Collaboration extension binds the
 * editor to that doc. The agent's draft arrives pre-stamped `ai:` (seeded server
 * side, purple); the AuthoredTracker stamps the local human's edits `human:`
 * (green). Snapshot serializes the editor to markdown and calls the snapshot
 * action; publish makes the current version live on the intranet reader.
 *
 * Mounting in the Nexus side panel must respect docs/features/
 * nexus-conversation-architecture.md: this component owns its own Y.Doc/provider
 * lifecycle and never touches the conversation runtime, so it cannot perturb the
 * stable conversation id.
 */

import { useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { Collaboration } from "@tiptap/extension-collaboration";
import { Markdown } from "tiptap-markdown";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { getSchemaExtensions } from "@/lib/content/collab/editor-extensions";
import { makeAuthorTag } from "@/lib/content/collab/provenance";
import { cn } from "@/lib/utils";
import { EditorToolbar } from "./EditorToolbar";
import { useEditorActions } from "./use-editor-actions";
import { AuthoredTracker } from "./authored-tracker";
import { ProvenanceRail } from "./provenance-rail";
import { SuggestionMode, useSuggestionState } from "./suggestion-mode";
import { CommentSidebar } from "./CommentSidebar";
import { acceptAllSuggestions } from "@/lib/content/collab/suggestions";
import "@/styles/atrium-content.css";

interface CollabSession {
  token: string;
  docName: string;
  wsPath: string;
  canEdit: boolean;
}

type Status = "connecting" | "ready" | "error";

export interface DocumentEditorProps {
  /** Content object id or slug. */
  idOrSlug: string;
  /** The current user's id, stamped on their edits (green rail). */
  userId: number;
  /**
   * Layout context (Epic #1059 §17). `"page"` (default) is the full-width
   * `/atrium/[id]/edit` page: the 288px comment rail sits BESIDE the editor.
   * `"panel"` is the narrow Nexus workspace sibling (~380–720px), where a fixed
   * 288px side rail would collapse the editor to an unreadable sliver — so the
   * rail stacks BELOW the editor at full width instead.
   */
  layout?: "page" | "panel";
}

export function DocumentEditor({
  idOrSlug,
  userId,
  layout = "page",
}: DocumentEditorProps) {
  // Lazily create the Y.Doc once (a null ref initializer reads clearer than the
  // `undefined as unknown as Y.Doc` cast). The lazy init below runs on the first
  // render before any consumer, so `ydoc` is always a live doc by use.
  const ydocRef = useRef<Y.Doc | null>(null);
  if (!ydocRef.current) ydocRef.current = new Y.Doc();
  const ydoc = ydocRef.current;

  const providerRef = useRef<WebsocketProvider | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [canEdit, setCanEdit] = useState(false);
  // The resolved object UUID from the collab session (`docName`). The component is
  // mounted with `idOrSlug`, which MAY be a slug; the snapshot/publish actions must
  // target the stable UUID so a slug change between load and save can't retarget a
  // different object. Held in a ref so the action callbacks read the latest value
  // without re-creating on every resolve.
  const docNameRef = useRef<string | null>(null);

  // The editor binds to the Y.Doc directly; the provider syncs that same doc, so
  // the editor is created once (deps: []) and is unaffected by provider timing.
  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: false,
      extensions: [
        ...getSchemaExtensions(),
        Markdown,
        Collaboration.configure({ document: ydoc }),
        AuthoredTracker.configure({ by: makeAuthorTag("human", userId) }),
        // §18.1 track-changes: a client-only plugin layer (no schema change) that
        // turns edits into pending suggestions while its toggle is on. Coexists
        // with AuthoredTracker/ProvenanceRail as a separate visual layer.
        SuggestionMode.configure({
          by: makeAuthorTag("human", userId),
          defaultOn: false,
        }),
        ProvenanceRail,
      ],
    },
    []
  );

  // Open the collab session once per document.
  useEffect(() => {
    let cancelled = false;
    // Read the live Y.Doc from the ref inside the effect (a ref read needs no
    // dep entry, unlike the render-body `ydoc` const). It is created lazily on
    // first render, so it is always present here.
    const ydoc = ydocRef.current;
    if (!ydoc) return;

    // Fetch a fresh collab token. Used both for the initial connect and to
    // re-mint before each reconnect (the token TTL is short — see collab-token.ts).
    const fetchSession = async (): Promise<CollabSession> => {
      const res = await fetch(`/api/content/${encodeURIComponent(idOrSlug)}/collab`);
      if (!res.ok) throw new Error(`collab token request failed: ${res.status}`);
      return (await res.json()) as CollabSession;
    };

    (async () => {
      try {
        const session = await fetchSession();
        if (cancelled) return;
        // Capture the resolved UUID for the snapshot/publish action calls.
        docNameRef.current = session.docName;

        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${proto}//${window.location.host}${session.wsPath}`;
        // WebsocketProvider connects to `${url}/${docName}?token=...`. Separate
        // browser tabs sync through the server (BroadcastChannel only links tabs
        // in the same context).
        const provider = new WebsocketProvider(url, session.docName, ydoc, {
          params: { token: session.token },
        });

        // The collab token has a short TTL (collab-token.ts). y-websocket reuses
        // the constructor `params` on every reconnect, so after the TTL elapses a
        // reconnect (network blip, ECS deploy, idle disconnect) would replay a dead
        // token, the server would close with 4401, and the client would retry
        // forever with the same expired credential — silently dropping every edit.
        // `provider.params` is documented as safely mutable and is re-read on each
        // connection attempt, so we re-mint the token whenever the socket drops and
        // is about to reconnect. Guarded against overlap with a single in-flight
        // promise so a flapping connection can't stack concurrent mint requests.
        let reminting: Promise<void> | null = null;
        const remintToken = async () => {
          try {
            const next = await fetchSession();
            if (!cancelled && providerRef.current === provider) {
              provider.params = { token: next.token };
            }
          } catch {
            // Leave the existing (expired) token in place; the provider keeps
            // retrying and a later disconnect will attempt another re-mint.
          } finally {
            reminting = null;
          }
        };
        provider.on("status", (event: { status: string }) => {
          if (cancelled) return;
          if (event.status === "connecting") {
            setStatus("connecting");
          } else if (event.status === "disconnected" && !reminting) {
            reminting = remintToken();
          }
        });
        provider.on("sync", (synced: boolean) => {
          if (!cancelled && synced) setStatus("ready");
        });
        providerRef.current = provider;
        setCanEdit(session.canEdit);
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      providerRef.current?.destroy();
      providerRef.current = null;
      docNameRef.current = null;
      // Destroy the Y.Doc captured by THIS effect run so its CRDT state cannot
      // leak into a later document. The parent mounts this component with
      // `key={obj.id}`, so an id change fully remounts (fresh editor + fresh
      // Y.Doc); this cleanup tears down the doc that the unmounting instance
      // owned. Releasing it here also frees the Yjs structs eagerly instead of
      // waiting on GC.
      ydoc.destroy();
    };
  }, [idOrSlug]);

  // Apply edit permission to the editor once the session resolves.
  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);

  // Snapshot / publish / unpublish, with shared busy + success/error feedback.
  const {
    message,
    actionError,
    pendingApproval,
    busy,
    handleSnapshot,
    handlePublish,
    handleUnpublish,
  } = useEditorActions({ editor, idOrSlug, docNameRef });

  // Live track-changes toggle state + pending-suggestion count for the toolbar.
  const { suggesting, count: suggestionCount } = useSuggestionState(editor);

  return (
    <div className={cn("flex flex-col gap-2", layout === "panel" && "p-3")}>
      <EditorToolbar
        status={status}
        canEdit={canEdit}
        busy={busy}
        suggesting={suggesting}
        suggestionCount={suggestionCount}
        onSnapshot={handleSnapshot}
        onPublish={handlePublish}
        onUnpublish={handleUnpublish}
        onToggleSuggesting={() => editor?.commands.toggleSuggesting()}
        onAcceptAll={() => {
          if (editor) acceptAllSuggestions(editor);
        }}
      />
      <div className={cn("flex gap-4", layout === "panel" && "flex-col")}>
        <div className="atrium-editor min-w-0 flex-1">
          <EditorContent editor={editor} className="atrium-content" />
        </div>
        {/* Comment threads: a 288px right rail on the full PAGE (hidden on small
            viewports); stacked full-width BELOW the editor in the narrow §17
            workspace panel so the editor keeps the whole panel width. */}
        <div
          className={cn(
            "shrink-0",
            layout === "panel" ? "w-full border-t pt-3" : "hidden w-72 md:block"
          )}
        >
          <CommentSidebar idOrSlug={idOrSlug} editor={editor} canEdit={canEdit} />
        </div>
      </div>
      {message && (
        <p
          // A pending-approval outcome is announced as a status (not an error) and
          // styled amber — distinct from the red error and the neutral success
          // captions, mirroring VisibilityChip's §26.4 pending notice.
          aria-live="polite"
          role={pendingApproval ? "status" : undefined}
          className={cn(
            "text-xs",
            actionError
              ? "text-destructive"
              : pendingApproval
                ? "text-amber-600"
                : "text-muted-foreground"
          )}
        >
          {message}
        </p>
      )}
    </div>
  );
}

export default DocumentEditor;
