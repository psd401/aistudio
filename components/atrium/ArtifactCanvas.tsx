"use client";

/**
 * Atrium artifact canvas (#1052, Epic #1059, Phase 2, spec §19.1)
 *
 * The artifact authoring surface, built on the assistant-ui Claude-Artifacts
 * pattern: a `Preview | Code` toggle, a version dropdown (with per-version
 * provenance), a live sandboxed preview, and direct code editing. The primary
 * tweak path for most users is the adjacent chat (agent-authored re-prompts); the
 * Code tab is the direct-edit escape hatch (human-authored versions).
 *
 * Data flow:
 * - On mount / object change, fetch the version list (`listVersionsAction`) and
 *   load the head version's code (`getArtifactCodeAction`).
 * - Selecting a version in the dropdown loads that version's code.
 * - Preview renders the loaded code in `<ArtifactSandbox>` (cross-origin, §28.1).
 * - Saving in the Code tab calls `createVersionAction` (human-authored); we then
 *   refresh the version list and select the new head.
 *
 * The component owns only its own fetch/edit state; mounted inside the Nexus side
 * panel it never touches the conversation runtime (see DocumentEditor header and
 * docs/features/nexus-conversation-architecture.md).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getArtifactCodeAction } from "@/actions/db/atrium/get-artifact-code";
import { listVersionsAction, type VersionSummary } from "@/actions/db/atrium/list-versions";
import { createVersionAction } from "@/actions/db/atrium/create-version";
import type { BodyFormat } from "@/lib/content";
import { ArtifactSandbox } from "./ArtifactSandbox";
import { CodeEditor } from "./CodeEditor";
import "@/styles/atrium-content.css";

type Tab = "preview" | "code";
type LoadState = "loading" | "ready" | "error";

/** Label for a version in the dropdown: "v3 · AI (current)". */
function versionLabel(v: VersionSummary): string {
  const author = v.authorActor === "agent" ? " · AI" : " · you";
  return `v${v.versionNumber}${author}${v.isCurrent ? " (current)" : ""}`;
}

export interface ArtifactCanvasProps {
  /** Content object id or slug for the artifact. */
  idOrSlug: string;
  /** Whether the current user may edit (save new versions). */
  canEdit?: boolean;
}

export function ArtifactCanvas({ idOrSlug, canEdit = false }: ArtifactCanvasProps) {
  const [tab, setTab] = useState<Tab>("preview");
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);

  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [code, setCode] = useState<string>("");
  const [bodyFormat, setBodyFormat] = useState<BodyFormat>("html");
  // The resolved stable object UUID (idOrSlug may be a slug); save targets this.
  const objectIdRef = useRef<string | null>(null);

  // Load the code for a specific version (or the head when versionId is null).
  // Returns the resolved version id so callers can sync selection.
  // Accepts an optional `cancelled` ref so the initial-load effect can prevent
  // stale writes when `idOrSlug` changes before this resolves (prevents one
  // artifact's state from landing in a second artifact's view).
  const loadCode = useCallback(
    async (
      versionId: string | null,
      cancelled?: { current: boolean }
    ): Promise<string | null> => {
      const result = await getArtifactCodeAction(idOrSlug, versionId ?? undefined);
      if (cancelled?.current) return null; // effect was torn down; discard result
      if (!result.isSuccess) {
        setState("error");
        setMessage(result.message ?? "Failed to load artifact");
        return null;
      }
      objectIdRef.current = result.data.objectId;
      setCode(result.data.code);
      setBodyFormat(result.data.bodyFormat);
      setSelectedVersionId(result.data.versionId);
      setState("ready");
      return result.data.versionId;
    },
    [idOrSlug]
  );

  // Refresh the version list (after a save, or on initial load).
  const refreshVersions = useCallback(async (): Promise<VersionSummary[]> => {
    const result = await listVersionsAction(idOrSlug);
    if (result.isSuccess) {
      setVersions(result.data);
      return result.data;
    }
    return [];
  }, [idOrSlug]);

  // Initial load: versions + head code. Re-runs when the object changes. State
  // resets and fetches happen inside the async task (not synchronously in the
  // effect body) to avoid cascading renders; `state` already initializes to
  // "loading", so the first paint shows the loading state without a sync setState.
  useEffect(() => {
    // Use a ref (object) rather than a local `let` so `loadCode` can read the flag
    // after its own `await` resolves — a closure over a primitive `let cancelled`
    // would always see the stale `false` captured at call time.
    const cancelledRef = { current: false };
    void (async () => {
      setState("loading");
      setMessage(null);
      const [, headVersionId] = await Promise.all([
        refreshVersions(),
        loadCode(null, cancelledRef),
      ]);
      if (cancelledRef.current) return;
      if (headVersionId) setSelectedVersionId(headVersionId);
    })();
    return () => {
      cancelledRef.current = true;
    };
  }, [refreshVersions, loadCode]);

  const handleSelectVersion = useCallback(
    async (versionId: string) => {
      setState("loading");
      await loadCode(versionId);
    },
    [loadCode]
  );

  const handleSave = useCallback(
    async (next: string) => {
      const target = objectIdRef.current ?? idOrSlug;
      const result = await createVersionAction(target, {
        body: next,
        bodyFormat,
      });
      if (!result.isSuccess) {
        // Surface to the CodeEditor's save handler (it shows the message).
        throw new Error(result.message ?? "Save failed");
      }
      // Refresh the version list and select the new head so the dropdown and the
      // preview reflect the just-saved human version.
      const refreshed = await refreshVersions();
      const newHead = result.data.version;
      if (newHead) {
        setSelectedVersionId(newHead.id);
        setCode(next);
      } else if (refreshed[0]) {
        setSelectedVersionId(refreshed[0].id);
      }
    },
    [idOrSlug, bodyFormat, refreshVersions]
  );

  return (
    <div className="atrium-artifact-canvas flex flex-col gap-2">
      <div className="flex items-center gap-3 text-xs text-gray-500">
        {/* Preview | Code toggle */}
        <div className="inline-flex overflow-hidden rounded border" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "preview"}
            onClick={() => setTab("preview")}
            className={`px-2 py-1 ${tab === "preview" ? "bg-gray-100 font-medium" : "hover:bg-gray-50"}`}
          >
            Preview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "code"}
            onClick={() => setTab("code")}
            className={`border-l px-2 py-1 ${tab === "code" ? "bg-gray-100 font-medium" : "hover:bg-gray-50"}`}
          >
            Code
          </button>
        </div>

        {/* Version dropdown */}
        {versions.length > 0 && (
          <label className="flex items-center gap-1">
            <span className="sr-only">Version</span>
            <select
              value={selectedVersionId ?? ""}
              onChange={(e) => handleSelectVersion(e.target.value)}
              className="rounded border px-1 py-1"
              data-testid="artifact-version-select"
            >
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {versionLabel(v)}
                </option>
              ))}
            </select>
          </label>
        )}

        <span aria-live="polite" className="ml-auto">
          {state === "loading" && "Loading…"}
          {state === "error" && (message ?? "Error")}
        </span>
      </div>

      {/* Canvas body */}
      {state === "error" ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {message ?? "Could not load this artifact."}
        </div>
      ) : tab === "preview" ? (
        <ArtifactSandbox key={selectedVersionId ?? ""} code={code} className="atrium-artifact-preview" />
      ) : (
        <CodeEditor
          value={code}
          bodyFormat={bodyFormat}
          editable={canEdit}
          onSave={canEdit ? handleSave : undefined}
        />
      )}

      <p className="text-xs text-gray-500">
        Tweak by asking in chat — or edit the code directly.
      </p>
    </div>
  );
}

export default ArtifactCanvas;
