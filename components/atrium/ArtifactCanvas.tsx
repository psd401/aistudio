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
 * - Selecting a version in the dropdown loads that version's code (preview-only;
 *   the working head is unchanged). "Restore this version" (editors, non-current
 *   selection) additionally repoints the working head at the previewed version
 *   via `rollbackVersionAction` (Epic #1059 completion).
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
import { rollbackVersionAction } from "@/actions/db/atrium/rollback-version";
import type { BodyFormat, ContentDataAccess } from "@/lib/content";
import { ArtifactSandbox } from "./ArtifactSandbox";
import { CodeEditor } from "./CodeEditor";
import "@/styles/atrium-content.css";

type Tab = "preview" | "code";
type LoadState = "loading" | "ready" | "error";

/**
 * UTF-8-safe base64 encode of artifact code for the save request. The edge WAF
 * (CrossSiteScripting_BODY) blocks a raw request body containing <script>/<style>
 * — the exact markup a legitimate artifact carries — so the code is sent
 * base64-encoded (an inert `[A-Za-z0-9+/=]` string) and decoded server-side
 * before screening. `btoa` only accepts Latin-1, so encode to UTF-8 bytes first,
 * chunking to stay clear of the String.fromCharCode argument-count limit on large
 * artifacts.
 */
function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

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

/**
 * Restore the SELECTED (non-current) version as the working head (Epic #1059
 * completion). The selected version's code is already loaded in the canvas
 * (the preview-version behavior is unchanged); rollback only repoints the head,
 * so afterwards we refresh the version list for the moved `(current)` marker.
 * Module-level (setters threaded in) to keep the component body under the
 * max-lines-per-function lint, mirroring VisibilityChip's performVisibilitySave.
 */
async function performRestore(args: {
  target: string;
  version: VersionSummary;
  refreshVersions: () => Promise<VersionSummary[] | null>;
  setRestoring: (v: boolean) => void;
  setRestoreNotice: (v: string | null) => void;
}): Promise<void> {
  const { target, version, refreshVersions, setRestoring, setRestoreNotice } = args;
  if (
    typeof window !== "undefined" &&
    !window.confirm(
      `Restore v${version.versionNumber} as the current version? Publishing will then make v${version.versionNumber} live.`
    )
  ) {
    return;
  }
  setRestoring(true);
  setRestoreNotice(null);
  try {
    const result = await rollbackVersionAction(target, version.id);
    if (!result.isSuccess) {
      setRestoreNotice(result.message ?? "Could not restore this version");
      return;
    }
    // Refresh so `isCurrent` moves to the restored version. On a transient
    // refresh failure the prior list is preserved (refreshVersions contract);
    // the restore itself already committed.
    await refreshVersions();
    setRestoreNotice(`Restored v${version.versionNumber} as current`);
  } catch (err) {
    setRestoreNotice(
      err instanceof Error ? err.message : "Could not restore this version"
    );
  } finally {
    setRestoring(false);
  }
}

/** The canvas header: Preview|Code toggle, version dropdown, restore, status. */
function CanvasToolbar({
  tab,
  onTab,
  versions,
  selectedVersionId,
  onSelectVersion,
  onRestore,
  canEdit,
  restoring,
  state,
  message,
  notice,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  versions: VersionSummary[];
  selectedVersionId: string | null;
  onSelectVersion: (id: string) => void;
  /** Restore the selected version as the working head. */
  onRestore: () => void;
  /** Whether the viewer may edit (the restore action re-checks server-side). */
  canEdit: boolean;
  restoring: boolean;
  state: LoadState;
  message: string | null;
  /** Restore success/failure feedback (shown only when the canvas is ready). */
  notice: string | null;
}) {
  // Restorable when the viewer may edit and the previewed version is NOT
  // already the working head (derived here so the parent stays lean).
  const selected = versions.find((v) => v.id === selectedVersionId) ?? null;
  const canRestore = canEdit && selected !== null && !selected.isCurrent;
  return (
    <div className="atrium-artifact-toolbar">
      <div className="atrium-artifact-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "preview"}
          onClick={() => onTab("preview")}
          className="atrium-artifact-tab"
          data-active={tab === "preview" ? "true" : "false"}
        >
          Preview
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "code"}
          onClick={() => onTab("code")}
          className="atrium-artifact-tab"
          data-active={tab === "code" ? "true" : "false"}
        >
          Code
        </button>
      </div>

      {versions.length > 0 && (
        <label className="atrium-artifact-verlabel">
          <span className="sr-only">Version</span>
          <select
            value={selectedVersionId ?? ""}
            onChange={(e) => onSelectVersion(e.target.value)}
            className="atrium-artifact-select"
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

      {canRestore && (
        <button
          type="button"
          onClick={onRestore}
          disabled={restoring || state === "loading"}
          className="atrium-artifact-restore"
          data-testid="artifact-restore-version"
        >
          {restoring ? "Restoring…" : "Restore this version"}
        </button>
      )}

      <span aria-live="polite" className="atrium-artifact-status">
        {state === "loading" && "Loading…"}
        {state === "error" && (message ?? "Error")}
        {state === "ready" && notice}
      </span>
    </div>
  );
}

interface ArtifactCanvasBaseProps {
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

/**
 * The preview's artifact data bridge (#1725).
 *
 * Mirrors `ArtifactSandboxProps`: the bridge is absent unless a caller that has
 * already resolved the object SERVER-SIDE hands over both the trusted content id
 * and the `dataAccess` mode read for this load. Modelling it as a discriminated
 * union rather than two optional props means a caller cannot enable the bridge
 * without pinning a mode, and every caller that stays silent (thumbnails, embeds)
 * keeps failing closed at the type boundary.
 *
 * `contentId` is deliberately NOT derived from `idOrSlug`: that prop may be a
 * slug, and the bridge's whole authority boundary is that the id comes from
 * trusted props rather than anything the artifact or the URL can influence.
 */
type ArtifactCanvasBridgeProps =
  | {
      dataBridgeEnabled: true;
      contentId: string;
      dataAccess: ContentDataAccess;
    }
  | { dataBridgeEnabled?: false; contentId?: never; dataAccess?: never };

export type ArtifactCanvasProps = ArtifactCanvasBaseProps &
  ArtifactCanvasBridgeProps;

/**
 * The standing hint under the canvas. Both routes are real — the agent rebuilds
 * the page from a description, and the Code tab edits it by hand — so this must
 * stay in step with the "Ask the agent" rail, which used to claim the opposite
 * ("You never edit the HTML by hand").
 */
function CanvasHint(): React.JSX.Element {
  return (
    <p className="atrium-artifact-hint">
      Tweak by asking in chat — or edit the code directly.
    </p>
  );
}

/**
 * Whether the canvas loaded fine but has no version to show: an artifact created
 * without a body has `currentVersionId === null`, and `getArtifactCodeAction`
 * answers with `versionId: null` and empty code. Distinct from the "loading" and
 * "error" load states, both of which are tracked separately.
 */
function isEmptyDraft(selectedVersionId: string | null, code: string): boolean {
  return selectedVersionId === null && code === "";
}

/**
 * An artifact with no snapshotted version yet (created without a body).
 * Previewing "" would mount a blank iframe that reads as a broken page, so say
 * what is actually true and point at the two ways forward.
 */
function EmptyDraftPanel({ canEdit }: { canEdit: boolean }): React.JSX.Element {
  return (
    <div className="atrium-artifact-empty" style={{ minHeight: "75vh" }}>
      <p className="atrium-artifact-empty-title">Nothing here yet</p>
      <p className="atrium-artifact-empty-body">
        {canEdit
          ? "Ask the agent in chat to build this page, or switch to the Code tab and write it yourself."
          : "This page has no content yet."}
      </p>
    </div>
  );
}

/** The narrowed bridge inputs the preview frame needs, or null when disabled. */
type CanvasBridge = { contentId: string; dataAccess: ContentDataAccess } | null;

/**
 * Narrow the props union ONCE, here: destructuring `contentId`/`dataAccess`
 * alongside the base props inside the component would lose the correlation
 * TypeScript needs to prove the two are present together, so the bridge is read
 * off the whole `props` object and carried as a single nullable value.
 *
 * Module-level rather than inlined at its one call site for the same reason
 * `performRestore` is: `ArtifactCanvas` sits exactly at the 150-line
 * max-lines-per-function lint, and folding these four lines back into the body
 * takes it to 154 — a warning, which `--max-warnings 0` turns into a failed gate.
 */
function resolveCanvasBridge(props: ArtifactCanvasProps): CanvasBridge {
  return props.dataBridgeEnabled === true
    ? { contentId: props.contentId, dataAccess: props.dataAccess }
    : null;
}

/**
 * The preview frame, extracted so the sandbox's two contracts live in one place.
 *
 * KEY (the reason this is not a plain element): the loaded-mode pin (#1712)
 * lives in a ref for the sandbox mount's lifetime, so a mount must belong to
 * exactly one artifact in exactly one mode. `key={selectedVersionId}` alone is
 * the long-standing version-switch mechanism — each version renders in a FRESH
 * iframe with no JS state carried over — but it is not enough once the bridge is
 * live:
 *  - contentId: no caller today can actually reach this with a stale mount —
 *    every one of them already remounts the canvas when the artifact changes
 *    (`ArtifactAuthoringView` keys it on `obj.id`; the two page mounts are route
 *    renders; and `WorkspacePanel`'s render-phase reset commits its "loading"
 *    branch, which unmounts the canvas outright — measured, not reasoned). The
 *    id stays in the key so that invariant is LOCAL rather than a convention
 *    every future caller has to remember: a canvas mounted unkeyed still cannot
 *    leave one artifact's pin attached to another artifact's id.
 *  - dataAccess: flipping the mode in Content settings triggers
 *    `router.refresh()`. A remount is exactly the "fresh load" #1712 requires —
 *    the old iframe is destroyed, so nothing queried under the old mode survives
 *    into the new one — and without it the author would have to reload the page
 *    by hand to test the mode they just chose, which is the loop #1725 removes.
 *
 * The two explicit branches are deliberate: `ArtifactSandboxProps` is a
 * discriminated union, and a spread of an optional-property object satisfies
 * neither arm of it.
 */
function ArtifactPreviewFrame({
  code,
  sandboxSrc,
  versionKey,
  bridge,
}: {
  code: string;
  sandboxSrc: string | null;
  versionKey: string;
  bridge: CanvasBridge;
}): React.JSX.Element {
  if (!bridge) {
    return (
      <ArtifactSandbox
        key={versionKey}
        code={code}
        src={sandboxSrc}
        className="atrium-artifact-preview"
      />
    );
  }
  return (
    <ArtifactSandbox
      key={`${bridge.contentId}:${bridge.dataAccess}:${versionKey}`}
      code={code}
      src={sandboxSrc}
      className="atrium-artifact-preview"
      dataBridgeEnabled={true}
      contentId={bridge.contentId}
      dataAccess={bridge.dataAccess}
    />
  );
}

export function ArtifactCanvas(props: ArtifactCanvasProps) {
  const { idOrSlug, canEdit = false, sandboxSrc = null } = props;
  const [tab, setTab] = useState<Tab>("preview");
  const [state, setState] = useState<LoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);

  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [code, setCode] = useState<string>("");
  const [bodyFormat, setBodyFormat] = useState<BodyFormat>("html");
  // Restore-selected-version state (Epic #1059 completion): `restoring` blocks
  // double-fire; `restoreNotice` is the success/failure caption (kept separate
  // from `message`, which belongs to the load-error state machine).
  const [restoring, setRestoring] = useState(false);
  const [restoreNotice, setRestoreNotice] = useState<string | null>(null);
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
      setRestoreNotice(null);
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
      // A stale restore caption for a previously-selected version would mislead
      // once a different version is being previewed.
      setRestoreNotice(null);
      try {
        // loadCode's own seq token makes the latest selection win.
        await loadCode(versionId);
      } catch (err) {
        // loadCode handles `isSuccess: false` internally, but a throw from the
        // server action itself (non-2xx / network failure) escapes it. Without
        // this catch the rejection is unhandled and the canvas stays stuck in
        // "loading" with no error surfaced — mirror the initial useEffect's
        // try/catch. Token-guard so a stale selection doesn't clobber a newer one.
        setState((prev) => (prev === "loading" ? "error" : prev));
        setMessage(err instanceof Error ? err.message : "Failed to load version");
      }
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
      // base64-encode the code so a <script>/<style>-bearing artifact is opaque to
      // the edge WAF on this server-action POST; the action decodes before write.
      const result = await createVersionAction(
        target,
        { body: toBase64Utf8(next), bodyFormat },
        { codeEncoding: "base64" }
      );
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

  const handleRestore = useCallback(() => {
    const version = versions.find((v) => v.id === selectedVersionId);
    if (!version || version.isCurrent) return;
    void performRestore({
      // Target the resolved UUID (idOrSlug may be a slug); loadCode has always
      // populated objectIdRef by the time a version is selectable.
      target: objectIdRef.current ?? idOrSlug,
      version,
      refreshVersions,
      setRestoring,
      setRestoreNotice,
    });
  }, [versions, selectedVersionId, idOrSlug, refreshVersions]);

  return (
    <div className="atrium-artifact-canvas flex flex-col gap-2">
      <CanvasToolbar
        tab={tab}
        onTab={setTab}
        versions={versions}
        selectedVersionId={selectedVersionId}
        onSelectVersion={handleSelectVersion}
        onRestore={handleRestore}
        canEdit={canEdit}
        restoring={restoring}
        state={state}
        message={message}
        notice={restoreNotice}
      />

      {/* Canvas body */}
      {state === "error" ? (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {message ?? "Could not load this artifact."}
        </div>
      ) : state === "loading" ? (
        // While loading, `code` is still "" and `selectedVersionId` is null.
        // Rendering <ArtifactSandbox> here would mount an iframe with empty code
        // and key="" — if its onLoad races ahead of loadCode it posts an empty
        // render, clearing the sandbox host's placeholder to a blank frame before
        // the real key/code arrives. A stable-height placeholder avoids that
        // empty-code mount and prevents layout shift when the real body lands.
        // minHeight 75vh matches the loaded preview (.atrium-artifact-preview) so
        // the canvas does not jump when the artifact body arrives.
        <div style={{ minHeight: "75vh" }} aria-busy="true" />
      ) : isEmptyDraft(selectedVersionId, code) && tab === "preview" ? (
        <EmptyDraftPanel canEdit={canEdit} />
      ) : tab === "preview" ? (
        // See ArtifactPreviewFrame for the version-remount and data-bridge
        // (#1725) contracts this one element carries.
        <ArtifactPreviewFrame code={code} sandboxSrc={sandboxSrc} versionKey={selectedVersionId ?? ""} bridge={resolveCanvasBridge(props)} />
      ) : (
        <CodeEditor
          value={code}
          bodyFormat={bodyFormat}
          editable={canEdit}
          onSave={canEdit ? handleSave : undefined}
        />
      )}

      <CanvasHint />
    </div>
  );
}

export default ArtifactCanvas;
