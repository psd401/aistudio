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

import { useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useEditor, EditorContent } from "@tiptap/react";
import { Collaboration } from "@tiptap/extension-collaboration";
import { Markdown } from "tiptap-markdown";
import { getSchemaExtensions } from "@/lib/content/collab/editor-extensions";
import { makeAuthorTag } from "@/lib/content/collab/provenance";
import { useUser } from "@/components/auth/user-provider";
import { EditorToolbar } from "./EditorToolbar";
import { EditorBubbleMenu } from "./EditorBubbleMenu";
import { useEditorActions } from "./use-editor-actions";
import { AuthoredTracker } from "./authored-tracker";
import { ProvenanceRail } from "./provenance-rail";
import { SuggestionMode, useSuggestionState } from "./suggestion-mode";
import { CommentSidebar } from "./CommentSidebar";
import { usePresence, type MarginAvatar, type LocalPresenceUser } from "./use-presence";
import { useCollabSession, type CollabStatus } from "./use-collab-session";
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
  actionError,
  pendingApproval,
}: {
  message: string | null;
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
  eyebrow,
  title,
  byline,
  body,
  comments,
}: {
  sheetRef: React.RefObject<HTMLDivElement | null>;
  margins: MarginAvatar[];
  eyebrow?: string;
  title: string;
  byline: string;
  body: React.ReactNode;
  comments: React.ReactNode;
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
          {eyebrow && <div className="mer-sheet-eyebrow">{eyebrow}</div>}
          <h1 className="mer-sheet-title">{title}</h1>
          <div className="mer-sheet-byline" data-testid="editor-byline">
            {byline}
          </div>
          {body}
        </div>
      </div>
      <div className="mer-comments">{comments}</div>
    </div>
  );
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
}: DocumentEditorProps) {
  // The collab session (Y.Doc + provider + status + canEdit) lives in a dedicated
  // hook so this component stays focused on layout + presence composition.
  const { ydoc, provider, status, canEdit, docNameRef } =
    useCollabSession(idOrSlug);
  // The sheet wrap — positioning context for the margin presence avatars.
  const sheetRef = useRef<HTMLDivElement | null>(null);

  const { user } = useUser();

  // The editor binds to the Y.Doc directly; the provider syncs that same doc, so
  // the editor is created once (deps: []) and is unaffected by provider timing.
  // The collaboration cursor is wired later against the ready provider via
  // usePresence (editor.registerPlugin) so this single-creation invariant holds.
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

  const docTitle = title ?? "Untitled";
  const crumbs = breadcrumb ?? [];

  const toolbar = (
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
  );

  const bubble =
    editor && canEdit ? (
      <EditorBubbleMenu editor={editor} askAgentHref={askAgentHref ?? "#"} />
    ) : null;

  const statusCaption = (
    <StatusCaption
      message={message}
      actionError={actionError}
      pendingApproval={pendingApproval}
    />
  );

  const editorBody = (
    <div className="atrium-editor min-w-0">
      <EditorContent editor={editor} className="atrium-content" />
      {bubble}
    </div>
  );
  const comments = (
    <CommentSidebar idOrSlug={idOrSlug} editor={editor} canEdit={canEdit} />
  );

  // --- Narrow Nexus workspace panel: compact stacked form ----------------------
  // The panel mounts under /nexus (outside the Atrium layout), so it carries the
  // `.atrium-meridian` scope class itself to resolve the `.mer-*` tokens.
  if (layout === "panel") {
    return (
      <div className="atrium-meridian flex flex-col gap-2 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <PresenceStack
            roster={roster}
            localUserId={userId}
            agentWriting={agentWriting}
          />
          {toolbar}
        </div>
        {editorBody}
        <div className="w-full border-t pt-3">{comments}</div>
        {statusCaption}
      </div>
    );
  }

  // --- Full page: the Meridian sheet on the desk -------------------------------
  return (
    <div className="mer-editor">
      <EditorTopbar
        title={docTitle}
        breadcrumb={crumbs}
        agentWriting={agentWriting}
        roster={roster}
        localUserId={userId}
        controls={
          <>
            {toolbar}
            {historyControl}
            {settingsControl}
          </>
        }
      />
      <MeridianDesk
        sheetRef={sheetRef}
        margins={margins}
        eyebrow={eyebrow}
        title={docTitle}
        byline={bylineText(roster, userId, agentWriting, status)}
        body={editorBody}
        comments={comments}
      />
      {statusCaption}
    </div>
  );
}

export default DocumentEditor;
