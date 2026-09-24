/**
 * The artifact preview's failure ring buffer (#1787).
 *
 * WHY THIS EXISTS: a Nexus chat can write an artifact, watch it render, and be
 * told nothing at all about whether its code worked. In the incident this issue
 * was filed from, the model rewrote a dashboard with a filter built on a column
 * that does not exist, then reported to the user that the dropdown "is populated
 * live from the database at load time." Every query had failed. Nothing in the
 * turn could have told it otherwise: the preview runs in a cross-origin sandbox
 * in the user's browser, and the model only ever sees tool results.
 *
 * So the preview records its failures here, and the next chat request carries
 * them to the server, where `read_workspace_content` returns them as
 * `previewDiagnostics`. The model can then fix its own SQL on the NEXT turn —
 * the buffer is read once when a request is sent, so it can never describe a
 * version the model writes during that same request.
 *
 * SHAPE OF THE SOLUTION — a module-level client singleton, deliberately not a
 * React context and not a conversation-runtime subscription. `WorkspacePanel`
 * and `ArtifactCanvas` are pure layout siblings of the Nexus conversation tree
 * and must stay unaware of it (see their headers and
 * `docs/features/nexus-conversation-architecture.md`); the chat's request-body
 * builder must likewise not reach into the panel. A tiny shared module is the
 * same decoupling `workspace-change-event.ts` gets from a DOM event.
 *
 * TRUST: entries originate in the viewer's OWN browser, describing the viewer's
 * OWN failed requests, and they end up in that viewer's model context. They are
 * still bounded and flattened before they leave (see `recordArtifactPreviewDiagnostic`
 * and `boundBridgeErrorMessage`) — an artifact author controls the SQL text and
 * an uncaught error message, so neither may grow without limit or smuggle line
 * structure into a prompt. The SERVER re-applies both bounds; this module is the
 * first, not the only, guard.
 */

import {
  boundBridgeErrorMessage,
  isArtifactBridgeErrorCode,
  type ArtifactBridgeErrorCode,
} from "@/lib/content/artifact-bridge-errors";

/** How many failures are remembered. Oldest are dropped first. */
export const MAX_PREVIEW_DIAGNOSTICS = 10;
/** How much of the failing SQL is kept, purely to identify WHICH query broke. */
export const MAX_PREVIEW_DIAGNOSTIC_SQL_LENGTH = 200;

export interface ArtifactPreviewDiagnostic {
  /** `data` — an AtriumData bridge call failed. `script` — the frame threw. */
  kind: "data" | "script";
  /** The typed bridge code, for `kind: "data"`. */
  code?: ArtifactBridgeErrorCode;
  message: string;
  /** A prefix of the SQL that failed, for `kind: "data"`. */
  sql?: string;
  /** Epoch milliseconds, so the model can tell a stale entry from a fresh one. */
  at: number;
}

interface DiagnosticsBuffer {
  /** The artifact these entries belong to. */
  contentId: string;
  entries: ArtifactPreviewDiagnostic[];
}

/**
 * One buffer, not a map keyed by artifact: exactly one workspace panel is open
 * at a time, and a map would quietly accumulate every artifact a long session
 * visited. Switching artifacts replaces the buffer outright, so the previous
 * artifact's failures can never be reported against the new one — and the
 * SERVER checks the `contentId` against the object it actually bound before it
 * shows the model anything.
 */
let buffer: DiagnosticsBuffer | null = null;

/** Bumped by every clear, so a restore can tell the preview has moved on. */
let generation = 0;

/** What the last take removed, held until the send it rode on succeeds or fails. */
let lastTaken: { generation: number; taken: DiagnosticsBuffer } | null = null;

/** Record one preview failure for `contentId`, evicting the oldest past the cap. */
export function recordArtifactPreviewDiagnostic(
  contentId: string,
  diagnostic: Omit<ArtifactPreviewDiagnostic, "at"> & { at?: number }
): void {
  const message = boundBridgeErrorMessage(diagnostic.message);
  if (!message) return;
  if (!buffer || buffer.contentId !== contentId) {
    buffer = { contentId, entries: [] };
  }
  const sql = diagnostic.sql
    ? boundBridgeErrorMessage(
        diagnostic.sql.slice(0, MAX_PREVIEW_DIAGNOSTIC_SQL_LENGTH)
      )
    : null;
  buffer.entries.push({
    kind: diagnostic.kind,
    ...(isArtifactBridgeErrorCode(diagnostic.code) ? { code: diagnostic.code } : {}),
    message,
    ...(sql ? { sql } : {}),
    at: typeof diagnostic.at === "number" ? diagnostic.at : Date.now(),
  });
  if (buffer.entries.length > MAX_PREVIEW_DIAGNOSTICS) {
    buffer.entries.splice(0, buffer.entries.length - MAX_PREVIEW_DIAGNOSTICS);
  }
}

/**
 * The current buffer, or null when nothing has failed. Returns a COPY: the chat
 * body builder serializes this while the preview may still be appending.
 */
export function readArtifactPreviewDiagnostics(): {
  contentId: string;
  entries: ArtifactPreviewDiagnostic[];
} | null {
  if (!buffer || buffer.entries.length === 0) return null;
  return { contentId: buffer.contentId, entries: [...buffer.entries] };
}

/**
 * Read the buffer AND empty it — what the chat request body uses. Each failure
 * reaches the model exactly once: re-sending it on every later turn kept
 * steering unrelated conversations back to a bug already reported. The failure
 * reappears only if the preview hits it again.
 */
export function takeArtifactPreviewDiagnostics(): ReturnType<
  typeof readArtifactPreviewDiagnostics
> {
  const taken = readArtifactPreviewDiagnostics();
  buffer = null;
  lastTaken = taken ? { generation, taken } : null;
  return taken;
}

/**
 * Put the last TAKEN entries back because the request that carried them never
 * reached the server (a pre-send session check, a network error, a non-2xx).
 * Without this a failed send silently loses them, and the preview may never
 * re-run the failing query to record them again.
 *
 * Skipped when the preview moved on since the take — a clear (new version or
 * mode) or a different artifact — because those entries no longer describe the
 * code on screen. Restored entries go BEFORE anything recorded since, oldest
 * first, under the same cap.
 */
export function restoreTakenArtifactPreviewDiagnostics(): void {
  const pending = lastTaken;
  lastTaken = null;
  if (!pending || pending.generation !== generation) return;
  const { contentId, entries } = pending.taken;
  if (buffer && buffer.contentId !== contentId) return;
  buffer = {
    contentId,
    entries: [...entries, ...(buffer?.entries ?? [])].slice(-MAX_PREVIEW_DIAGNOSTICS),
  };
}

/**
 * Drop everything. Called when a fresh version of the artifact is mounted: the
 * previous version's failures describe code that is no longer running, and
 * reporting them against the new code is how a model "fixes" a bug twice.
 */
export function clearArtifactPreviewDiagnostics(): void {
  buffer = null;
  generation += 1;
  lastTaken = null;
}
