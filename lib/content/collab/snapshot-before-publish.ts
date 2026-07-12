/**
 * Snapshot a document's LIVE content into a version before an agent publishes it.
 *
 * Epic #1059 follow-up (Codex review P1). Agent edits — `applyAgentEdit`, the
 * workspace `edit_workspace_document` / `edit_atrium_document` tools, and the
 * agent-bridge `replace`/`append` ops — land ONLY on the live Yjs collab doc +
 * its `atrium_doc_state` projection. They do NOT advance the persisted
 * content-version head. `publishService.publish` publishes that persisted head, so
 * a "write X then publish it" agent turn would otherwise publish the STALE (or
 * empty) head while the assistant reports success.
 *
 * The human editor gets this guarantee for free from a client-side debounced
 * autosave (`snapshotDocumentAction` over `toCleanMarkdown`); the server-side agent
 * has no such loop, so we snapshot here — reading the live Yjs doc as CLEAN,
 * accepted-baseline markdown (`readAgentDocCleanMarkdown`, matching the human path:
 * pending suggestion insertions removed, deletions kept, comment/suggestion marks
 * stripped) and persisting it as a new version (advancing the head) before publish.
 *
 * SAFE + best-effort:
 *  - documents only (artifacts advance their head via `createVersion` already);
 *  - only when the live read SUCCEEDS with non-empty content. An unreachable collab
 *    listener (null) or an empty live read falls back to publishing the existing
 *    head rather than blocking the publish or clobbering a good head with empty;
 *  - a failed snapshot is logged and the publish proceeds on the existing head.
 *
 * The live content was §28.3-screened when the agent wrote it, and
 * `versionService.snapshot` is a no-op screen for the delegated-user requester used
 * here — mirroring the human `snapshotDocumentAction` path.
 */

import { readAgentDocCleanMarkdown } from "./apply-agent-edit";
import { versionService } from "@/lib/content";
import type { Requester } from "@/lib/content/types";
import { createLogger } from "@/lib/logger";

export async function snapshotLiveDocumentForPublish(params: {
  req: Requester;
  objectId: string;
  kind: "document" | "artifact";
  requestId: string;
}): Promise<void> {
  const { req, objectId, kind, requestId } = params;
  if (kind !== "document") return;
  const log = createLogger({ requestId, module: "snapshot-before-publish" });

  let live: string | null;
  try {
    // Clean, accepted-baseline markdown (pending suggestion insertions removed,
    // deletions kept, comment/suggestion marks stripped) — same as the human
    // toCleanMarkdown snapshot, so no unaccepted-suggestion residue is published.
    live = await readAgentDocCleanMarkdown(objectId);
  } catch (err) {
    log.warn("pre-publish live read failed; publishing existing version head", {
      objectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // null = live collab listener unreachable; "" / whitespace = an empty live doc.
  // In both cases DON'T snapshot — publishing the existing head is safer than
  // blocking the publish or overwriting a good head with an empty version.
  if (live === null || live.trim().length === 0) {
    log.info("pre-publish live content unavailable/empty; publishing existing head", {
      objectId,
      live: live === null ? "unreachable" : "empty",
    });
    return;
  }

  try {
    await versionService.snapshot(
      req,
      { id: objectId, kind: "document" },
      { body: live, bodyFormat: "markdown", summary: "Snapshot before agent publish" }
    );
    log.info("pre-publish snapshot advanced the version head to live content", { objectId });
  } catch (err) {
    // canEdit was already confirmed by the publish surface; a snapshot failure here
    // (e.g. a concurrent version conflict) must not block the publish — fall back to
    // the existing head, matching the "publish what is persisted" default.
    log.warn("pre-publish snapshot failed; publishing existing version head", {
      objectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
