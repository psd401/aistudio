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
  // "· human" (not "· you"): VersionSummary intentionally omits authorUserId
  // (anti-enumeration), so we cannot know whether the human author is the current
  // viewer. "human" is accurate for every viewer; "you" would mislabel another
  // user's (e.g. an admin's) edit as the viewer's own.
  const author = v.authorActor === "agent" ? " · AI" : " · human";
  return `v${v.versionNumber}${author}${v.isCurrent ? " (current)" : ""}`;
}

/** A just-created head version's summary fields (subset of ContentVersionDTO). */
interface NewHead {
  id: string;
  versionNumber: number;
  authorActor: "human" | "agent";
  summary: string | null;
  createdAt: string | null;
}

/**
 * Optimistically fold a just-saved head version into the prior dropdown list so
 * the `<select value>` always has a matching `<option>` before the authoritative
 * refresh lands (a refresh that races ahead of read-replica propagation could
 * otherwise return a list missing the new version, leaving the select blank).
 * Idempotent: if the id is already present the list is returned unchanged.
 */
function withOptimisticHead(prev: VersionSummary[], head: NewHead): VersionSummary[] {
  if (prev.some((v) => v.id === head.id)) return prev;
  return [
    {
      id: head.id,
      versionNumber: head.versionNumber,
      authorActor: head.authorActor,
      summary: head.summary,
      createdAt: head.createdAt,
      isCurrent: true,
    },
    ...prev.map((v) => ({ ...v, isCurrent: false })),
  ];
}

/** The canvas header: Preview|Code toggle, version dropdown, status text. */
function CanvasToolbar({
  tab,
  onTab,
  versions,
  selectedVersionId,
  onSelectVersion,
  state,
  message,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  versions: VersionSummary[];
  selectedVersionId: string | null;
  onSelectVersion: (id: string) => void;
  state: LoadState;
  message: string | null;
}) {
  return (
    <div className="flex items-center gap-3 text-xs text-gray-500">
      <div className="inline-flex overflow-hidden rounded border" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "preview"}
          onClick={() => onTab("preview")}
          className={`px-2 py-1 ${tab === "preview" ? "bg-gray-100 font-medium" : "hover:bg-gray-50"}`}
        >
          Preview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "code"}
          onClick={() => onTab("code")}
          className={`border-l px-2 py-1 ${tab === "code" ? "bg-gray-100 font-medium" : "hover:bg-gray-50"}`}
        >
          Code
        </button>
      </div>

      {versions.length > 0 && (
        <label className="flex items-center gap-1">
          <span className="sr-only">Version</span>
          <select
            value={selectedVersionId ?? ""}
            onChange={(e) => onSelectVersion(e.target.value)}
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
  );
}

export interface ArtifactCanvasProps {
  /** Content object id or slug for the artifact. */
  idOrSlug: string;
  /** Whether the current user may edit (save new versions). */
  canEdit?: boolean;
  /**
   * Sandbox render URL (`<origin>/render`), resolved SERVER-SIDE by the page from
   * `ATRIUM_SANDBOX_ORIGIN` and threaded down to `<ArtifactSandbox>`. `null` when
   * the sandbox is unconfigured → the preview frame fails closed. (#1052)
   */
  sandboxSrc?: string | null;
}

export function ArtifactCanvas({ idOrSlug, canEdit = false, sandboxSrc = null }: ArtifactCanvasProps) {
  const [tab, setTab] = useState<Tab>("preview");
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);

  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [code, setCode] = useState<string>("");
  const [bodyFormat, setBodyFormat] = useState<BodyFormat>("html");
  // The resolved stable object UUID (idOrSlug may be a slug); save targets this.
  const objectIdRef = useRef<string | null>(null);

  // Monotonic token for code loads: only the MOST RECENT load is allowed to
  // apply its state. A rapid version switch (select v3, then v2 before v3's slow
  // S3 fetch resolves) would otherwise let whichever request finishes last win
  // all three setters, leaving the dropdown and preview out of sync. Each load
  // captures the token it was issued under and discards its result if a newer
  // load has since started. Also doubles as the unmount/idOrSlug-change guard.
  const loadSeqRef = useRef(0);

  // Load the code for a specific version (or the head when versionId is null).
  // Returns the resolved version id so callers can sync selection, or null if a
  // newer load superseded this one (its writes were discarded).
  const loadCode = useCallback(
    async (versionId: string | null): Promise<string | null> => {
      const seq = ++loadSeqRef.current;
      const result = await getArtifactCodeAction(idOrSlug, versionId ?? undefined);
      // Discard if a newer load started (rapid select) or the component/object
      // changed (the effect bumps the token on cleanup) while we awaited.
      if (seq !== loadSeqRef.current) return null;
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

  // Refresh the version list. On failure, the PRIOR list is preserved (we never
  // clobber a good list with [] on a transient list-fetch error, which would
  // hide the dropdown for a still-loaded artifact). The `seq` guard discards a
  // stale refresh after the object changed. Returns the fetched list (or null
  // when the fetch failed or was superseded) so callers can react.
  //
  // NOTE on the token: `seq` must be a token THIS caller owns exclusively for the
  // lifetime of the refresh. Do NOT pass the same token that `loadCode` will also
  // bump (loadCode increments `loadSeqRef` on entry) — that would make the guard
  // below fire spuriously and silently drop a valid version list. Callers that
  // run refreshVersions concurrently with loadCode should pass no token (the
  // setState into "loading"/the load itself already governs the object identity)
  // or a dedicated token, not loadCode's.
  const refreshVersions = useCallback(
    async (seq?: number): Promise<VersionSummary[] | null> => {
      const result = await listVersionsAction(idOrSlug);
      if (seq !== undefined && seq !== loadSeqRef.current) return null;
      if (result.isSuccess) {
        setVersions(result.data);
        return result.data;
      }
      return null;
    },
    [idOrSlug]
  );

  // Initial load: versions + head code. Re-runs when the object changes. State
  // resets and fetches happen inside the async task (not synchronously in the
  // effect body) to avoid cascading renders; `state` already initializes to
  // "loading", so the first paint shows the loading state without a sync setState.
  useEffect(() => {
    // Bump the load token so any in-flight load/refresh from a previous object
    // is discarded. `loadCode` will bump it again on entry and OWN the token for
    // this run — so we must NOT pass a captured token to `refreshVersions` (doing
    // so made its guard fire on every mount, dropping the version list → empty
    // dropdown). `loadCode` is the single owner of the staleness invariant; a
    // version list that arrives for a superseded object is harmless (the next
    // load's setState replaces it), so refreshVersions runs untokened here.
    loadSeqRef.current += 1;
    void (async () => {
      setState("loading");
      setMessage(null);
      try {
        // loadCode sets selectedVersionId internally on success; we don't need
        // its return value here. Both run concurrently; if either rejects the
        // catch surfaces an error rather than leaving the canvas stuck loading.
        await Promise.all([refreshVersions(), loadCode(null)]);
      } catch (err) {
        // A newer load (object change) bumps the token; only surface the error if
        // this run is still the current one, otherwise the next run owns state.
        setState((prev) => (prev === "loading" ? "error" : prev));
        setMessage(err instanceof Error ? err.message : "Failed to load artifact");
      }
    })();
    return () => {
      // Invalidate this run: a higher token means any pending load/refresh from
      // this object discards its writes.
      loadSeqRef.current += 1;
    };
  }, [refreshVersions, loadCode]);

  const handleSelectVersion = useCallback(
    async (versionId: string) => {
      setState("loading");
      // loadCode's own seq token makes the latest selection win.
      await loadCode(versionId);
    },
    [loadCode]
  );

  const handleSave = useCallback(
    async (next: string) => {
      // Capture the load token at save time so the post-save reconciliation does
      // not clobber a DIFFERENT mounted object. If the user navigates to another
      // artifact mid-save, the effect cleanup bumps loadSeqRef and we bail before
      // committing any version/selection state into the wrong canvas.
      const saveSeq = loadSeqRef.current;
      const target = objectIdRef.current ?? idOrSlug;
      const result = await createVersionAction(target, {
        body: next,
        bodyFormat,
      });
      if (saveSeq !== loadSeqRef.current) return; // object changed during save
      if (!result.isSuccess) {
        // Surface to the CodeEditor's save handler (it shows the message).
        throw new Error(result.message ?? "Save failed");
      }
      // Defensive optional chaining: `version` may be absent on an unexpected
      // success payload — fall back to a refresh-driven head selection below.
      const newHead = result.data?.version;
      // Optimistically reflect the new head in the dropdown BEFORE the refresh so
      // the <select value> always has a matching <option> (see withOptimisticHead).
      if (newHead) {
        setVersions((prev) => withOptimisticHead(prev, newHead));
        setSelectedVersionId(newHead.id);
        setCode(next);
      }
      // Reconcile with the authoritative server list (idempotent; replaces the
      // optimistic entry). Token-guarded so a refresh that resolves after the
      // user navigated away does not write into the wrong canvas. A failure
      // preserves the optimistic list above.
      const refreshed = await refreshVersions(saveSeq);
      if (saveSeq !== loadSeqRef.current) return;
      if (!newHead && refreshed && refreshed[0]) {
        // No version id came back from createVersion — adopt the refreshed head
        // AND reload its code so the editor/preview reflect the saved content
        // (otherwise the selection changes but the body stays stale: split-brain).
        await loadCode(refreshed[0].id);
      }
    },
    [idOrSlug, bodyFormat, refreshVersions, loadCode]
  );

  return (
    <div className="atrium-artifact-canvas flex flex-col gap-2">
      <CanvasToolbar
        tab={tab}
        onTab={setTab}
        versions={versions}
        selectedVersionId={selectedVersionId}
        onSelectVersion={handleSelectVersion}
        state={state}
        message={message}
      />

      {/* Canvas body */}
      {state === "error" ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {message ?? "Could not load this artifact."}
        </div>
      ) : tab === "preview" ? (
        <ArtifactSandbox key={selectedVersionId ?? ""} code={code} src={sandboxSrc} className="atrium-artifact-preview" />
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
