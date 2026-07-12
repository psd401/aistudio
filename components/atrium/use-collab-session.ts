"use client";

/**
 * Atrium collab session hook (extracted from DocumentEditor for Epic #1059 slice C)
 *
 * Owns the per-document collaboration lifecycle so the editor component stays
 * small: it lazily creates the Y.Doc, fetches a short-TTL collab token (GET
 * /api/content/[id]/collab), opens a `WebsocketProvider` bound to that doc, and
 * re-mints the token on every reconnect so an expired credential can't silently
 * drop edits. The Y.Doc is returned for the editor's `Collaboration` extension;
 * the provider is returned (as state) so the presence layer can read its
 * awareness once it is ready.
 *
 * The Y.Doc is created ONCE per mount and destroyed on unmount — DocumentEditor
 * mounts with `key={obj.id}`, so switching documents fully remounts (fresh doc +
 * fresh provider), and this hook's cleanup tears down the doc the unmounting
 * instance owned (also freeing Yjs structs eagerly instead of waiting on GC).
 */

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";

interface CollabSession {
  token: string;
  docName: string;
  wsPath: string;
  canEdit: boolean;
}

export type CollabStatus = "connecting" | "ready" | "error";

export interface UseCollabSessionResult {
  /** The live Y.Doc — pass to the editor's Collaboration extension. */
  ydoc: Y.Doc;
  /** The provider once connected (null while the token is being fetched). */
  provider: WebsocketProvider | null;
  status: CollabStatus;
  canEdit: boolean;
  /** The resolved object UUID (`docName`) for the snapshot/publish actions. */
  docNameRef: RefObject<string | null>;
}

export function useCollabSession(idOrSlug: string): UseCollabSessionResult {
  // Lazily create the Y.Doc once (a null ref initializer reads clearer than the
  // `undefined as unknown as Y.Doc` cast). The lazy init runs on the first render
  // before any consumer, so `ydoc` is always a live doc by use.
  const ydocRef = useRef<Y.Doc | null>(null);
  if (!ydocRef.current) ydocRef.current = new Y.Doc();
  const ydoc = ydocRef.current;

  const providerRef = useRef<WebsocketProvider | null>(null);
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);
  const [status, setStatus] = useState<CollabStatus>("connecting");
  const [canEdit, setCanEdit] = useState(false);
  const docNameRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const ydoc = ydocRef.current;
    if (!ydoc) return;

    // Fetch a fresh collab token — used both for the initial connect and to
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
        docNameRef.current = session.docName;

        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${proto}//${window.location.host}${session.wsPath}`;
        // WebsocketProvider connects to `${url}/${docName}?token=...`. Separate
        // browser tabs sync through the server (BroadcastChannel only links tabs
        // in the same context).
        const wsProvider = new WebsocketProvider(url, session.docName, ydoc, {
          params: { token: session.token },
        });

        // y-websocket reuses the constructor `params` on every reconnect, so after
        // the short TTL a reconnect would replay a dead token, the server closes
        // 4401, and the client retries forever with the expired credential —
        // silently dropping every edit. `provider.params` is documented as safely
        // mutable and re-read on each connection attempt, so re-mint whenever the
        // socket drops. Guarded with a single in-flight promise so a flapping
        // connection can't stack concurrent mint requests.
        let reminting: Promise<void> | null = null;
        const remintToken = async () => {
          try {
            const next = await fetchSession();
            if (!cancelled && providerRef.current === wsProvider) {
              wsProvider.params = { token: next.token };
            }
          } catch {
            // Leave the existing (expired) token in place; the provider keeps
            // retrying and a later disconnect attempts another re-mint.
          } finally {
            reminting = null;
          }
        };
        wsProvider.on("status", (event: { status: string }) => {
          if (cancelled) return;
          if (event.status === "connecting") {
            setStatus("connecting");
          } else if (event.status === "disconnected" && !reminting) {
            reminting = remintToken();
          }
        });
        wsProvider.on("sync", (synced: boolean) => {
          if (!cancelled && synced) setStatus("ready");
        });
        providerRef.current = wsProvider;
        setProvider(wsProvider);
        setCanEdit(session.canEdit);
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      providerRef.current?.destroy();
      providerRef.current = null;
      setProvider(null);
      docNameRef.current = null;
      ydoc.destroy();
    };
  }, [idOrSlug]);

  return { ydoc, provider, status, canEdit, docNameRef };
}
