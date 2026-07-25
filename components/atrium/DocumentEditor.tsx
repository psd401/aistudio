"use client";

/**
 * Atrium document editor (#1051; Meridian redesign Epic #1059 slice C)
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
 * Meridian (slice C): in `page` layout the editor renders as a white 700px sheet
 * on the soft `#EDEFEC` desk with a topbar (breadcrumb, title, live "✦ AGENT
 * WRITING" pill, presence avatars, Suggesting/History/Publish controls), a
 * floating dark formatting toolbar (`EditorBubbleMenu`), a clean comment rail, and
 * REAL presence (`usePresence` reads the provider awareness that was previously
 * configured but never read: topbar + margin avatars + inline remote carets). The
 * narrow Nexus workspace `panel` layout keeps its compact stacked form.
 *
 * Mounting in the Nexus side panel must respect docs/features/
 * nexus-conversation-architecture.md: this component owns its own Y.Doc/provider
 * lifecycle and never touches the conversation runtime, so it cannot perturb the
 * stable conversation id.
 */

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useEditor, EditorContent, ReactNodeViewRenderer } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { Collaboration } from "@tiptap/extension-collaboration";
import type * as Y from "yjs";
import { Markdown } from "tiptap-markdown";
import type { Node as TiptapNode, Extensions } from "@tiptap/core";
import { getSchemaExtensions } from "@/lib/content/collab/editor-extensions";
import { ARTIFACT_EMBED_NODE_NAME } from "@/lib/content/collab/artifact-embed-node";
import { ArtifactEmbedNodeView } from "./ArtifactEmbedNodeView";
import { ArtifactEmbedPaste } from "./artifact-embed-paste";
import { makeAuthorTag } from "@/lib/content/collab/provenance";
import { useUser } from "@/components/auth/user-provider";
import { EditorToolbar } from "./EditorToolbar";
import { PublishMenu } from "./PublishMenu";
import { CopyableLink } from "./CopyableLink";
import { EditableSheetTitle } from "./EditableSheetTitle";
import { EditorBubbleMenu } from "./EditorBubbleMenu";
import { DocumentCover } from "./DocumentCover";
import { useEditorActions } from "./use-editor-actions";
import { AuthoredTracker } from "./authored-tracker";
import { ProvenanceRail } from "./provenance-rail";
import { SuggestionMode, useSuggestionState } from "./suggestion-mode";
import { CommentSidebar } from "./CommentSidebar";
import { usePresence, type MarginAvatar, type LocalPresenceUser } from "./use-presence";
import { useCollabSession, type CollabStatus } from "./use-collab-session";
import { useProvenancePref } from "./use-provenance-pref";
import { renderColorFor, initialsFromName, type PresenceUser } from "@/lib/atrium/presence";
import { acceptAllSuggestions } from "@/lib/content/collab/suggestions";
import "@/styles/atrium-content.css";
// The Meridian editor classes (.mer-*) live here. Imported at the COMPONENT level
// (not only via the Atrium layout) so the editor is styled wherever it mounts —
// including the Nexus workspace panel (/nexus), which is outside the Atrium
// layout. The `.mer-*` tokens are scoped to `.atrium-meridian`, so the panel-mode
// root below carries that scope class to resolve them (the full-page mount already
// sits inside the Atrium layout's scope). The floating BubbleMenu appends to the
// editor's parent element, which is inside this scope in both modes.
import "@/styles/atrium-meridian.css";

type Status = CollabStatus;

/**
 * Attach the live React NodeView to the shared `atriumArtifactEmbed` node for the
 * CLIENT editor only. The shared schema (`getSchemaExtensions`) defines the node
 * schema-only (React-free) so the server/collab bundle stays lean; here we
 * `.extend` just that one node with `addNodeView` — which does NOT alter the node
 * spec, so client/server schema parity (asserted by the collab-schema smoke) holds.
 */
function withEmbedNodeView(extensions: Extensions): Extensions {
  return extensions.map((ext) =>
    ext.name === ARTIFACT_EMBED_NODE_NAME
      ? (ext as TiptapNode).extend({
          addNodeView: () => ReactNodeViewRenderer(ArtifactEmbedNodeView),
        })
      : ext
  );
}

/** A breadcrumb crumb — a plain label, optionally a link. */
export interface BreadcrumbCrumb {
  label: string;
  href?: string;
}

export interface DocumentEditorProps {
  /** Content object id or slug. */
  idOrSlug: string;
  /** The current user's id, stamped on their edits (green rail). */
  userId: number;
  /**
   * Layout context (Epic #1059 §17). `"page"` (default) is the full-width
   * `/atrium/[id]/edit` page: the Meridian sheet + 296px comment rail on the desk.
   * `"panel"` is the narrow Nexus workspace sibling (~380–720px), where the sheet
   * chrome would not fit — so it keeps a compact stacked form.
   */
  layout?: "page" | "panel";
  /** Document title, shown as the sheet's H1 + the topbar breadcrumb tail. */
  title?: string;
  /** Violet eyebrow above the title (e.g. "SPECIAL EDUCATION · PROCEDURE"). */
  eyebrow?: string;
  /** Breadcrumb crumbs before the title (e.g. the collection). Page layout only. */
  breadcrumb?: BreadcrumbCrumb[];
  /** History control (VersionMenu) rendered in the topbar. Page layout only. */
  historyControl?: React.ReactNode;
  /** Settings/visibility controls rendered in the topbar. Page layout only. */
  settingsControl?: React.ReactNode;
  /** Where the bubble-menu "✦ Ask agent" navigates (doc beside the Nexus chat). */
  askAgentHref?: string;
  /** Persisted cover-gradient preset key (slice F), or null. Page layout only. */
  coverGradient?: string | null;
  /** Persisted doc emoji icon (slice F), or null. Page layout only. */
  icon?: string | null;
}

/** The topbar presence avatar stack (real awareness roster + live agent). */
function PresenceStack({
  roster,
  localUserId,
  agentWriting,
}: {
  roster: PresenceUser[];
  localUserId: number;
  agentWriting: boolean;
}): React.JSX.Element | null {
  if (roster.length === 0 && !agentWriting) return null;
  return (
    <div className="mer-presence" aria-label="People here">
      {roster.map((u) => (
        <span
          key={u.clientId}
          className="mer-presence-avatar"
          data-kind={u.kind}
          style={{ background: renderColorFor(u, localUserId) }}
          title={
            localUserId != null && u.id === localUserId ? `${u.name} (you)` : u.name
          }
        >
          {u.initials}
        </span>
      ))}
      {agentWriting && (
        <span
          className="mer-presence-avatar"
          data-kind="agent"
          style={{ background: "var(--mer-agent)" }}
          title="Agent is writing"
        >
          ✦
        </span>
      )}
    </div>
  );
}

/** Byline sentence for the sheet header (who is editing + connection status). */
function bylineText(
  roster: PresenceUser[],
  localUserId: number,
  agentWriting: boolean,
  status: Status
): string {
  const others = roster.filter(
    (u) => u.kind === "human" && u.id !== localUserId
  );
  let who = "You";
  if (others.length === 1) who = `You and ${others[0].name}`;
  else if (others.length > 1) who = `You and ${others.length} others`;
  const agent = agentWriting ? " · ✦ Agent is writing" : "";
  const state =
    status === "connecting"
      ? "connecting…"
      : status === "error"
        ? "reconnecting…"
        : "saved";
  return `${who} editing${agent} · ${state}`;
}

/** Build the broadcast presence identity from the auth user + the numeric id. */
function buildLocalUser(
  user: { firstName?: string | null; lastName?: string | null; email?: string | null } | null,
  userId: number
): LocalPresenceUser | null {
  if (!user) return null;
  const name =
    [user.firstName, user.lastName].filter(Boolean).join(" ").trim() ||
    user.email ||
    "You";
  return { id: userId, name, initials: initialsFromName(name, user.email) };
}

/** The snapshot/publish feedback caption below the desk (amber for pending). */
function StatusCaption({
  message,
  messageUrl,
  actionError,
  pendingApproval,
}: {
  message: string | null;
  /** Reader URL for a successful publish (#1336 C3), shown as a copyable link. */
  messageUrl: string | null;
  actionError: boolean;
  pendingApproval: boolean;
}): React.JSX.Element | null {
  if (!message) return null;
  const tone = actionError ? "error" : pendingApproval ? "pending" : "info";
  return (
    <p
      // A pending-approval outcome is announced as a status (not an error) and
      // styled amber — distinct from the red error and the neutral success
      // captions, mirroring VisibilityChip's §26.4 pending notice.
      aria-live="polite"
      role={pendingApproval ? "status" : undefined}
      className="mer-editor-status"
      data-tone={tone}
    >
      {message}
      {messageUrl && (
        <>
          {" — "}
          <CopyableLink url={messageUrl} testId="publish-reader-url" />
        </>
      )}
    </p>
  );
}

/** The Meridian editor topbar — breadcrumb, live agent pill, presence, controls. */
function EditorTopbar({
  title,
  breadcrumb,
  agentWriting,
  roster,
  localUserId,
  controls,
}: {
  title: string;
  breadcrumb: BreadcrumbCrumb[];
  agentWriting: boolean;
  roster: PresenceUser[];
  localUserId: number;
  controls: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mer-editor-topbar">
      <nav className="mer-breadcrumb" aria-label="Breadcrumb">
        <Link href="/atrium" className="mer-breadcrumb-crumb">
          Library
        </Link>
        {breadcrumb.map((crumb) => (
          <span key={crumb.label} className="mer-breadcrumb-crumb-group">
            <span className="mer-breadcrumb-sep" aria-hidden="true">
              /
            </span>{" "}
            {crumb.href ? (
              <Link href={crumb.href} className="mer-breadcrumb-crumb">
                {crumb.label}
              </Link>
            ) : (
              <span className="mer-breadcrumb-crumb">{crumb.label}</span>
            )}
          </span>
        ))}
        <span className="mer-breadcrumb-sep" aria-hidden="true">
          /
        </span>
        <span className="mer-breadcrumb-title">{title}</span>
      </nav>
      {agentWriting && (
        <span className="mer-pill-agent-writing" data-testid="agent-writing-pill">
          <span className="mer-pill-spark" aria-hidden="true">
            ✦
          </span>
          AGENT WRITING
        </span>
      )}
      <span className="mer-editor-topbar-spacer" />
      <PresenceStack
        roster={roster}
        localUserId={localUserId}
        agentWriting={agentWriting}
      />
      <div className="mer-editor-controls">{controls}</div>
    </div>
  );
}

/** The Meridian editor desk — the sheet (margins + header + body) and the rail. */
function MeridianDesk({
  sheetRef,
  margins,
  cover,
  eyebrow,
  titleNode,
  byline,
  body,
  comments,
  commentsOpen,
}: {
  sheetRef: React.RefObject<HTMLDivElement | null>;
  margins: MarginAvatar[];
  cover?: React.ReactNode;
  eyebrow?: string;
  /** The sheet H1 — an inline-editable title for editors, static for viewers. */
  titleNode: React.ReactNode;
  byline: string;
  body: React.ReactNode;
  comments: React.ReactNode;
  /**
   * Whether the 296px comment rail is expanded (#1336 B3). When collapsed the
   * column is `display: none` — NOT unmounted — so `CommentSidebar` keeps
   * feeding the topbar its open-comment count, and the desk's
   * `justify-content` re-centers the sheet for free.
   */
  commentsOpen: boolean;
}): React.JSX.Element {
  return (
    <div className="mer-editor-desk">
      <div className="mer-sheet-wrap" ref={sheetRef}>
        {margins.map((m) => (
          <span
            key={m.key}
            className="mer-margin-avatar"
            data-kind={m.kind}
            style={{ top: `${m.top}px`, background: m.color }}
            aria-hidden="true"
          >
            {m.initials}
          </span>
        ))}
        <div className="mer-sheet">
          {cover}
          {eyebrow && <div className="mer-sheet-eyebrow">{eyebrow}</div>}
          {titleNode}
          <div className="mer-sheet-byline" data-testid="editor-byline">
            {byline}
          </div>
          {body}
        </div>
      </div>
      <div
        className="mer-comments"
        data-open={commentsOpen ? "true" : "false"}
        data-testid="comment-rail"
      >
        {comments}
      </div>
    </div>
  );
}

/**
 * The narrow Nexus workspace panel (§17) — a compact stacked form. It mounts
 * under /nexus (outside the Atrium layout), so it carries the `.atrium-meridian`
 * scope class itself to resolve the `.mer-*` tokens. Extracted so the
 * DocumentEditor body stays under the max-lines lint.
 */
function PanelLayout({
  presence,
  controls,
  editorBody,
  comments,
  commentsOpen,
  statusCaption,
}: {
  presence: React.ReactNode;
  controls: React.ReactNode;
  editorBody: React.ReactNode;
  comments: React.ReactNode;
  /** Whether the comment block is expanded (#1336 B3). */
  commentsOpen: boolean;
  statusCaption: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="atrium-meridian flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {presence}
        <div className="mer-ectl-group">{controls}</div>
      </div>
      {editorBody}
      {/* Collapsed with `hidden`, NOT unmounted: CommentSidebar owns the thread
          data and keeps feeding the toggle its open-comment count. */}
      <div className="w-full border-t pt-3" hidden={!commentsOpen}>
        {comments}
      </div>
      {statusCaption}
    </div>
  );
}

/**
 * The full-page Meridian editor: the topbar + the sheet-on-desk + the status
 * caption. Composes the already-extracted EditorTopbar + MeridianDesk so the
 * DocumentEditor body stays under the max-lines lint.
 */
function FullPageLayout({
  docTitle,
  crumbs,
  agentWriting,
  roster,
  localUserId,
  controls,
  sheetRef,
  margins,
  cover,
  eyebrow,
  titleNode,
  byline,
  editorBody,
  comments,
  commentsOpen,
  statusCaption,
}: {
  docTitle: string;
  crumbs: BreadcrumbCrumb[];
  agentWriting: boolean;
  roster: PresenceUser[];
  localUserId: number;
  controls: React.ReactNode;
  sheetRef: React.RefObject<HTMLDivElement | null>;
  margins: MarginAvatar[];
  cover: React.ReactNode;
  eyebrow?: string;
  titleNode: React.ReactNode;
  byline: string;
  editorBody: React.ReactNode;
  comments: React.ReactNode;
  /** Whether the comment rail is expanded (#1336 B3). */
  commentsOpen: boolean;
  statusCaption: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mer-editor">
      <EditorTopbar
        title={docTitle}
        breadcrumb={crumbs}
        agentWriting={agentWriting}
        roster={roster}
        localUserId={localUserId}
        controls={controls}
      />
      <MeridianDesk
        sheetRef={sheetRef}
        margins={margins}
        cover={cover}
        eyebrow={eyebrow}
        titleNode={titleNode}
        byline={byline}
        body={editorBody}
        comments={comments}
        commentsOpen={commentsOpen}
      />
      {statusCaption}
    </div>
  );
}

/**
 * Topbar chip toggling the comment rail, badged with the open-comment count
 * (#1336 B3). Mirrors the `mer-ectl` + `data-active` pattern the Suggesting
 * control uses.
 */
function CommentsToggle({
  open,
  openCount,
  onToggle,
}: {
  open: boolean;
  openCount: number;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="mer-ectl"
      data-active={open ? "true" : "false"}
      aria-pressed={open}
      onClick={onToggle}
      data-testid="comments-toggle"
      title={open ? "Hide comments" : "Show comments"}
    >
      <span aria-hidden="true">💬</span>
      <span data-testid="comments-open-count">{openCount}</span>
      <span className="sr-only">
        {openCount === 1 ? "1 open comment" : `${openCount} open comments`}
      </span>
    </button>
  );
}

/**
 * Topbar chip toggling the provenance rail (#1336 B7). Sits next to Suggesting
 * and mirrors its `mer-ectl` + `data-active` pattern.
 */
function ProvenanceToggle({
  on,
  onToggle,
}: {
  on: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="mer-ectl"
      data-active={on ? "true" : "false"}
      aria-pressed={on}
      onClick={onToggle}
      data-testid="provenance-toggle"
      title={on ? "Hide who wrote what" : "Show who wrote what"}
    >
      <span aria-hidden="true">🎨</span> Authorship
    </button>
  );
}

/**
 * Comment-rail visibility (#1336 B3). The rail used to occupy its full 296px
 * unconditionally, even on a document with no comments at all. It now defaults
 * to open ONLY when the document actually has open threads, and the topbar chip
 * overrides that either way. `CommentSidebar` owns the thread data and reports
 * the count up, so this never triggers a second fetch.
 */
function useCommentsRail() {
  const [openCount, setOpenCount] = useState(0);
  // `null` = the first count has not arrived yet, so no default has been picked.
  const [userChoice, setUserChoice] = useState<boolean | null>(null);
  const [autoOpen, setAutoOpen] = useState(false);

  const handleOpenCountChange = useCallback((next: number) => {
    setOpenCount(next);
    // Only the FIRST settled count seeds the default; later counts must not
    // reopen a rail the user deliberately closed.
    setAutoOpen((prev) => prev || next > 0);
  }, []);

  const commentsOpen = userChoice ?? autoOpen;
  const toggleComments = useCallback(
    () => setUserChoice(!commentsOpen),
    [commentsOpen]
  );

  return { openCount, commentsOpen, toggleComments, handleOpenCountChange };
}

/**
 * Local title state that re-syncs when the server `title` prop changes (e.g. a
 * Settings-dialog rename → router.refresh() delivers a fresh prop; the page keys
 * the editor on the object id only, so it never remounts). Uses the React
 * "adjust state on prop change during render" pattern — no effect, no cascading
 * render. An inline commit updates both this state and the DB, so the eventual
 * refreshed prop is a no-op here.
 */
function useSyncedTitle(title?: string): [string, (next: string) => void] {
  const [docTitle, setDocTitle] = useState(title ?? "Untitled");
  const [syncedTitle, setSyncedTitle] = useState(title);
  if (title !== syncedTitle) {
    setSyncedTitle(title);
    setDocTitle(title ?? "Untitled");
  }
  return [docTitle, setDocTitle];
}

/**
 * The editor surface: the ProseMirror content plus the floating bubble toolbar,
 * wrapped in the `.atrium-editor` element that carries the two CSS-only display
 * flags.
 */
function EditorSurface({
  editor,
  askAgentHref,
  provenanceOn,
  suggesting,
}: {
  editor: Editor | null;
  /** Where the bubble-menu "✦ Ask agent" navigates. */
  askAgentHref?: string;
  /** Provenance rail shown (#1336 B7). */
  provenanceOn: boolean;
  /** Suggesting mode active (#1336 B6) — drives the document-level mode cue. */
  suggesting: boolean;
}): React.JSX.Element {
  return (
    <div
      className="atrium-editor min-w-0"
      // CSS-only gating (#1336 B7 / B6): both attributes drive presentation
      // rules in atrium-content.css. No plugin, schema, decoration or Yjs write
      // is involved — the authorship marks and rail decorations stay in the
      // document either way.
      data-provenance={provenanceOn ? "on" : "off"}
      data-suggesting={suggesting ? "true" : "false"}
    >
      <EditorContent editor={editor} className="atrium-content" />
      {/* Mounted as soon as the editor exists — NOT gated on `canEdit` (#1336
          B4). Gating the mount meant the plugin was registered only after the
          collab token round-trip resolved, a window long enough that users
          reliably selected text into a dead toolbar. `EditorBubbleMenu`'s own
          `shouldShow` already returns false unless `e.isEditable`, so a
          read-only viewer still never sees it — the permission gate is
          unchanged, only its location. */}
      {editor && (
        <EditorBubbleMenu editor={editor} askAgentHref={askAgentHref ?? "#"} />
      )}
    </div>
  );
}

/**
 * Create the Atrium TipTap editor and keep its editability in sync.
 *
 * The editor binds to the Y.Doc directly; the provider syncs that same doc, so
 * the editor is created ONCE (deps: []) and is unaffected by provider timing.
 * The collaboration cursor is wired later against the ready provider via
 * `usePresence` (`editor.registerPlugin`), so that single-creation invariant
 * holds.
 */
function useAtriumEditor(ydoc: Y.Doc, userId: number, editable: boolean) {
  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: false,
      extensions: [
        // Client editor: the shared schema + the live embed NodeView attached to
        // the (schema-only) atriumArtifactEmbed node.
        ...withEmbedNodeView(getSchemaExtensions()),
        // Client-only: pasting a bare `::atrium-artifact{id="…"}` directive becomes
        // the live embed node (no schema change → client/server parity holds).
        ArtifactEmbedPaste,
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

  // `useLayoutEffect`, not `useEffect` (#1336 B4): child passive effects run
  // BEFORE the parent's, so when `editable` flipped true the BubbleMenu child
  // registered its ProseMirror plugin first and its constructor-time
  // `shouldShow` sampled `editor.isEditable === false`. `setEditable` does not
  // re-evaluate `shouldShow` on its own (`updatePluginViews` early-returns when
  // neither the selection nor the doc changed), so the toolbar stayed dead until
  // some unrelated doc-changing transaction — e.g. adding a comment — forced a
  // re-evaluation. Running this layout effect first means the plugin constructor
  // observes the correct editability.
  useLayoutEffect(() => {
    editor?.setEditable(editable);
  }, [editor, editable]);

  return editor;
}

export function DocumentEditor({
  idOrSlug,
  userId,
  layout = "page",
  title,
  eyebrow,
  breadcrumb,
  historyControl,
  settingsControl,
  askAgentHref,
  coverGradient,
  icon,
}: DocumentEditorProps) {
  // The collab session (Y.Doc + provider + status + canEdit) lives in a dedicated
  // hook so this component stays focused on layout + presence composition.
  const { ydoc, provider, status, canEdit, synced, docNameRef } =
    useCollabSession(idOrSlug);
  // Typing is enabled only once the persisted document state has actually
  // arrived (#1336 B5). Before the first sync the Y.Doc is empty, so an editable
  // sheet showed a blank body that accepted keystrokes which were then merged
  // against the real content the moment it landed.
  const editable = canEdit && synced;
  // The sheet wrap — positioning context for the margin presence avatars.
  const sheetRef = useRef<HTMLDivElement | null>(null);

  const { user } = useUser();

  const editor = useAtriumEditor(ydoc, userId, editable);

  // Snapshot / publish / unpublish, with shared busy + success/error feedback.
  const {
    message,
    messageUrl,
    actionSeq,
    actionError,
    pendingApproval,
    busy,
    handleSnapshot,
    handlePublish,
    handleUnpublish,
  } = useEditorActions({ editor, idOrSlug, docNameRef });

  // Live track-changes toggle state + pending-suggestion count for the toolbar.
  const { suggesting, count: suggestionCount } = useSuggestionState(editor);

  // Comment-rail visibility + the topbar chip's open-comment badge (#1336 B3).
  const { openCount, commentsOpen, toggleComments, handleOpenCountChange } =
    useCommentsRail();

  // Provenance-rail visibility, per viewer (#1336 B7).
  const [provenanceOn, toggleProvenance] = useProvenancePref();

  // Real presence — the awareness roster (topbar + margin avatars), inline remote
  // carets, and the live "agent is writing" signal. Memoized so the awareness /
  // cursor-plugin wiring effect in usePresence keys on a STABLE identity and does
  // not re-register the cursor plugin on every render.
  const localUser = useMemo(() => buildLocalUser(user, userId), [user, userId]);
  const { roster, margins, agentWriting } = usePresence({
    editor,
    provider,
    sheetRef,
    localUser,
  });

  // The title is inline-editable (README: New-doc lands on a blank sheet with an
  // editable title); the hook keeps the sheet H1 / breadcrumb / byline in sync
  // with both inline commits and out-of-band renames (Settings dialog).
  const [docTitle, setDocTitle] = useSyncedTitle(title);
  const crumbs = breadcrumb ?? [];

  // The topbar control cluster common to both layouts: the Suggesting toolbar,
  // the two #1336 view toggles, and — for editors only — the primary "Publish ▾"
  // split control, rendered LAST per the spec topbar.
  const coreControls = (
    <>
      <EditorToolbar
        status={status}
        canEdit={canEdit}
        busy={busy}
        suggesting={suggesting}
        suggestionCount={suggestionCount}
        onToggleSuggesting={() => editor?.commands.toggleSuggesting()}
        onAcceptAll={() => {
          if (editor) acceptAllSuggestions(editor);
        }}
      />
      <ProvenanceToggle on={provenanceOn} onToggle={toggleProvenance} />
      <CommentsToggle
        open={commentsOpen}
        openCount={openCount}
        onToggle={toggleComments}
      />
    </>
  );
  const publishControl = canEdit ? (
    <PublishMenu
      idOrSlug={idOrSlug}
      busy={busy}
      refreshKey={actionSeq}
      onSnapshot={handleSnapshot}
      onPublish={handlePublish}
      onUnpublish={handleUnpublish}
    />
  ) : null;

  const statusCaption = (
    <StatusCaption {...{ message, messageUrl, actionError, pendingApproval }} />
  );

  const editorBody = (
    <EditorSurface
      editor={editor}
      askAgentHref={askAgentHref}
      provenanceOn={provenanceOn}
      suggesting={suggesting}
    />
  );
  const comments = (
    <CommentSidebar
      {...{ idOrSlug, editor, canEdit }}
      onOpenCountChange={handleOpenCountChange}
    />
  );

  const presence = (
    <PresenceStack roster={roster} localUserId={userId} agentWriting={agentWriting} />
  );

  // --- Narrow Nexus workspace panel (§17): compact stacked form ----------------
  if (layout === "panel") {
    return (
      <PanelLayout
        presence={presence}
        controls={<>{coreControls}{publishControl}</>}
        editorBody={editorBody}
        comments={comments}
        commentsOpen={commentsOpen}
        statusCaption={statusCaption}
      />
    );
  }

  // --- Full page: the Meridian sheet on the desk -------------------------------
  return (
    <FullPageLayout
      docTitle={docTitle}
      crumbs={crumbs}
      agentWriting={agentWriting}
      roster={roster}
      localUserId={userId}
      controls={
        <>
          {coreControls}
          {historyControl}
          {settingsControl}
          {publishControl}
        </>
      }
      sheetRef={sheetRef}
      margins={margins}
      cover={
        <DocumentCover
          objectId={idOrSlug}
          coverGradient={coverGradient ?? null}
          icon={icon ?? null}
          canEdit={canEdit}
        />
      }
      eyebrow={eyebrow}
      titleNode={
        <EditableSheetTitle
          objectId={idOrSlug}
          value={docTitle}
          canEdit={canEdit}
          onCommit={setDocTitle}
        />
      }
      byline={bylineText(roster, userId, agentWriting, status)}
      editorBody={editorBody}
      comments={comments}
      commentsOpen={commentsOpen}
      statusCaption={statusCaption}
    />
  );
}

export default DocumentEditor;
