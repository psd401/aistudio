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

import { useCallback, useEffect, useRef, useState } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import { Collaboration } from "@tiptap/extension-collaboration";
import { Markdown } from "tiptap-markdown";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { getSchemaExtensions } from "@/lib/content/collab/editor-extensions";
import { makeAuthorTag } from "@/lib/content/collab/provenance";
import { snapshotDocumentAction } from "@/actions/db/atrium/snapshot-document";
import { publishDocumentAction } from "@/actions/db/atrium/publish-document";
import { AuthoredTracker } from "./authored-tracker";
import { ProvenanceRail } from "./provenance-rail";
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
}

export function DocumentEditor({ idOrSlug, userId }: DocumentEditorProps) {
  const ydocRef = useRef<Y.Doc>(undefined as unknown as Y.Doc);
  if (!ydocRef.current) ydocRef.current = new Y.Doc();

  const providerRef = useRef<WebsocketProvider | null>(null);
  const [status, setStatus] = useState<Status>("connecting");
  const [canEdit, setCanEdit] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // The editor binds to the Y.Doc directly; the provider syncs that same doc, so
  // the editor is created once (deps: []) and is unaffected by provider timing.
  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: false,
      extensions: [
        ...getSchemaExtensions(),
        Markdown,
        Collaboration.configure({ document: ydocRef.current }),
        AuthoredTracker.configure({ by: makeAuthorTag("human", userId) }),
        ProvenanceRail,
      ],
    },
    []
  );

  // Open the collab session once per document.
  useEffect(() => {
    let cancelled = false;
    const ydoc = ydocRef.current;

    (async () => {
      try {
        const res = await fetch(`/api/content/${encodeURIComponent(idOrSlug)}/collab`);
        if (!res.ok) throw new Error(`collab token request failed: ${res.status}`);
        const session = (await res.json()) as CollabSession;
        if (cancelled) return;

        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${proto}//${window.location.host}${session.wsPath}`;
        // WebsocketProvider connects to `${url}/${docName}?token=...`. Separate
        // browser tabs sync through the server (BroadcastChannel only links tabs
        // in the same context).
        const provider = new WebsocketProvider(url, session.docName, ydoc, {
          params: { token: session.token },
        });
        provider.on("status", (event: { status: string }) => {
          if (!cancelled && event.status === "connecting") setStatus("connecting");
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
    };
  }, [idOrSlug]);

  // Apply edit permission to the editor once the session resolves.
  useEffect(() => {
    editor?.setEditable(canEdit);
  }, [editor, canEdit]);

  const handleSnapshot = useCallback(async () => {
    if (!editor) return;
    const body = editor.storage.markdown.getMarkdown();
    const result = await snapshotDocumentAction(idOrSlug, { body });
    setMessage(result.isSuccess ? "Snapshot saved" : result.message ?? "Snapshot failed");
  }, [editor, idOrSlug]);

  const handlePublish = useCallback(async () => {
    const result = await publishDocumentAction(idOrSlug, { destination: "intranet" });
    setMessage(result.isSuccess ? "Published to intranet" : result.message ?? "Publish failed");
  }, [idOrSlug]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3 text-xs text-gray-500">
        <span aria-live="polite">
          {status === "connecting" && "Connecting…"}
          {status === "ready" && (canEdit ? "Connected" : "Read-only")}
          {status === "error" && "Connection error"}
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--atrium-human)" }} />
          You
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: "var(--atrium-agent)" }} />
          Agent
        </span>
        {canEdit && (
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={handleSnapshot}
              className="rounded border px-2 py-1 hover:bg-gray-50"
            >
              Snapshot
            </button>
            <button
              type="button"
              onClick={handlePublish}
              className="rounded border px-2 py-1 hover:bg-gray-50"
            >
              Publish
            </button>
          </span>
        )}
      </div>
      <div className="atrium-editor">
        <EditorContent editor={editor} className="atrium-content" />
      </div>
      {message && <p className="text-xs text-gray-500">{message}</p>}
    </div>
  );
}

export default DocumentEditor;
