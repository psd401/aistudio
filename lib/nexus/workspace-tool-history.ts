/**
 * Prune stale workspace-tool payloads from the messages sent to the MODEL.
 *
 * Issue #1791 finding 7: every `update_workspace_artifact` call carries the
 * complete new source as its `input.code`, and every `read_workspace_content`
 * result carries the complete current source as its output. Both stay in the
 * conversation history and are re-sent on every subsequent turn. After five or
 * six edits of a 40 KB dashboard that is well over 100k tokens of source the
 * model has already superseded — it pays for it on every turn, it pushes real
 * context out of the window, and only the newest copy is even true.
 *
 * This keeps the MOST RECENT heavy workspace payload verbatim (the model
 * usually wants the code it just wrote) and replaces every earlier one with a
 * short stub naming the field and its size. The stub keeps the surrounding
 * part shape byte-for-byte — same `type`, `toolCallId`, `state`, and the same
 * keys in `input`/`output` — so `convertToModelMessages` still pairs every
 * tool call with its result (a dropped `tool_result` block is what raises
 * `AI_MissingToolResultsError` on replay; see the Silent Failures guide).
 *
 * This is a MODEL-side transform only. It is applied to `safeModelMessages`
 * and never to `safePersistenceMessages`, so what is written to the database —
 * and what the thread renders on reload — is untouched.
 */

import type { UIMessage } from "ai";

/**
 * Workspace tools whose inputs or outputs carry whole artifact/document
 * sources. Tools that only move small metadata around (publish, delete,
 * find_atrium_documents) are deliberately absent: their payloads are already
 * tiny, and stubbing them would cost clarity for no tokens.
 */
export const WORKSPACE_SOURCE_TOOLS = [
  "read_workspace_content",
  "update_workspace_artifact",
  "edit_workspace_document",
  "edit_atrium_document",
] as const;

/**
 * Strings at or above this length are pruned from superseded payloads. A 2 KB
 * floor keeps short fields (titles, summaries, a one-line diff, an error
 * message) fully intact — those are the parts of the history that still carry
 * meaning — while catching the artifact sources that actually drive the growth.
 */
const PRUNE_THRESHOLD_CHARS = 2_000;

/** Recursion bound: a malformed/adversarial part cannot spin the walker. */
const MAX_DEPTH = 8;

function isWorkspaceSourceToolPart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const record = part as Record<string, unknown>;
  const { type, toolName } = record;
  return WORKSPACE_SOURCE_TOOLS.some(
    (name) => toolName === name || type === `tool-${name}`
  );
}

function stub(fieldPath: string, length: number): string {
  return (
    `[omitted from history: ${length.toLocaleString("en-US")} characters of ` +
    `superseded ${fieldPath}. This is an EARLIER revision, not the current ` +
    `one — call read_workspace_content to see what the workspace holds now.]`
  );
}

function pruneValue(value: unknown, fieldPath: string, depth: number): unknown {
  if (typeof value === "string") {
    return value.length >= PRUNE_THRESHOLD_CHARS
      ? stub(fieldPath, value.length)
      : value;
  }
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      pruneValue(entry, `${fieldPath}[${index}]`, depth + 1)
    );
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      pruneValue(nested, key, depth + 1),
    ])
  );
}

/**
 * The payload carriers across BOTH representations this codebase produces:
 * `input`/`output` on AI SDK UI parts, `args`/`result` on persisted Nexus
 * parts (see `sanitizeMessagePartForReplay` in chat-helpers.ts, which handles
 * the same pair). Anything else on the part — `type`, `toolCallId`, `state`,
 * `errorText` — is left exactly as it was.
 */
const PAYLOAD_KEYS = ["input", "output", "args", "result"] as const;

function prunePart(part: unknown): unknown {
  if (!part || typeof part !== "object") return part;
  const record = part as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = { ...record };
  for (const key of PAYLOAD_KEYS) {
    if (!(key in record) || record[key] == null) continue;
    const pruned = pruneValue(record[key], key, 0);
    if (pruned !== record[key]) {
      next[key] = pruned;
      changed = true;
    }
  }
  return changed ? next : part;
}

/**
 * The object a workspace source part is about, read from its `objectId`. A
 * conversation can be rebound to another artifact mid-thread, so "superseded"
 * must mean "an earlier payload for the SAME object" — stubbing a different
 * object's source would label it stale when no later copy of it exists.
 *
 * Null when the part names no object: reads persisted before reads returned
 * `objectId`, and error results. Such a part cannot be proven to belong to the
 * same object as anything else, so it is kept verbatim — exactly what happened
 * to every part before pruning existed.
 */
function partObjectId(part: unknown): string | null {
  return stringField(part, "objectId") ?? null;
}

function stringField(part: unknown, field: string): string | undefined {
  const record = part as Record<string, unknown>;
  for (const key of PAYLOAD_KEYS) {
    const payload = record[key];
    if (payload && typeof payload === "object") {
      const value = (payload as Record<string, unknown>)[field];
      if (typeof value === "string") return value;
    }
  }
  return undefined;
}

function isReadPart(part: unknown): boolean {
  const { type, toolName } = part as Record<string, unknown>;
  return (
    toolName === "read_workspace_content" ||
    type === "tool-read_workspace_content"
  );
}

/** Byte offset of a read page (0 for a first/only page or an older part). */
function readOffset(part: unknown): number {
  const record = part as Record<string, unknown>;
  for (const key of PAYLOAD_KEYS) {
    const payload = record[key];
    if (payload && typeof payload === "object") {
      const offset = (payload as Record<string, unknown>).byteOffset;
      if (typeof offset === "number") return offset;
    }
  }
  return 0;
}

/**
 * How a write part changed the source:
 *  - "replace": it carried the WHOLE new source — artifact `code`, or a
 *    document edit with `mode: "replace"`. Everything earlier is superseded.
 *  - "append": a document edit in the tools' default `append` mode. It ADDS to
 *    the document, so the earlier read and earlier appends are still part of
 *    the current source and must not be stubbed.
 *  - "none": no source at all, e.g. a mode-only `update_workspace_artifact`
 *    (`code` null, only `dataAccess`). The source did not change.
 */
function writeKind(part: unknown): "replace" | "append" | "none" {
  const record = part as Record<string, unknown>;
  for (const key of ["input", "args"] as const) {
    const payload = record[key];
    if (!payload || typeof payload !== "object") continue;
    const { code, markdown, mode } = payload as Record<string, unknown>;
    if (typeof code === "string" && code.length > 0) return "replace";
    if (typeof markdown === "string") {
      return mode === "replace" ? "replace" : "append";
    }
  }
  return "none";
}

/**
 * Which workspace source parts to keep verbatim. Per object:
 *  - the newest REPLACING write (whole new code/markdown) is kept, and so is
 *    every append after it — together they are the current source;
 *  - after it, the newest READ SEQUENCE is the current revision. A sequence
 *    starts at a read of offset 0; a large source is then paged at higher
 *    offsets, and every page is needed to reconstruct it, so the newest read
 *    at EACH offset within that sequence is kept;
 *  - everything else for the object is superseded: reads and writes before
 *    the newest replacing write, an older re-read of the same page, and pages
 *    from an EARLIER read sequence. A fresh offset-0 read means the model started
 *    over, and the source may have changed outside this chat in between (the
 *    Code tab, another editor), so old higher-offset pages must never be
 *    stitched onto the new first page.
 */
function partsToKeep(messages: UIMessage[]): Set<string> {
  const { sourceParts, lastWrite, lastSequenceStart } =
    indexSourceParts(messages);

  const keep = new Map<string, string>();
  for (const { pos: at, key, part } of sourceParts) {
    const objectId = partObjectId(part);
    if (objectId === null) {
      // No object named: cannot be proven superseded, so never pruned.
      keep.set(`unidentified:${key}`, key);
      continue;
    }
    const writeAt = lastWrite.get(objectId) ?? 0;
    if (!isReadPart(part)) {
      // The newest replacement and every append after it are the current
      // source — unless a fresh offset-0 read came later, which already holds
      // them (and any change made outside this chat). A mode-only write
      // carries no source, so keeping it is free.
      const kind = writeKind(part);
      const sequenceAt = lastSequenceStart.get(objectId) ?? 0;
      const current =
        at === writeAt || (kind === "append" && at >= Math.max(writeAt, sequenceAt));
      if (current || kind === "none") keep.set(`write:${key}`, key);
      continue;
    }
    // The current read sequence starts at the newest offset-0 read, or at the
    // newest replacing write when paging has not restarted since.
    if (at < Math.max(writeAt, lastSequenceStart.get(objectId) ?? 0)) continue;
    // Later reads of the same page overwrite earlier ones.
    keep.set(`read:${objectId}:${readOffset(part)}`, key);
  }
  return new Set(keep.values());
}

/**
 * One pass over the history: every workspace source part in order, plus, per
 * object, the position of the newest replacing write and of the newest offset-0
 * read (the start of the newest read sequence).
 */
function indexSourceParts(messages: UIMessage[]): {
  sourceParts: Array<{ pos: number; key: string; part: unknown }>;
  lastWrite: Map<string, number>;
  lastSequenceStart: Map<string, number>;
} {
  const lastWrite = new Map<string, number>();
  const lastSequenceStart = new Map<string, number>();
  const sourceParts: Array<{ pos: number; key: string; part: unknown }> = [];
  let pos = 0;
  for (const [m, message] of messages.entries()) {
    const parts = message?.parts;
    if (!Array.isArray(parts)) continue;
    for (const [p, part] of parts.entries()) {
      if (!isWorkspaceSourceToolPart(part)) continue;
      pos += 1;
      sourceParts.push({ pos, key: `${m}:${p}`, part });
      const objectId = partObjectId(part);
      // An unidentified part neither supersedes nor is superseded.
      if (objectId === null) continue;
      if (isReadPart(part)) {
        if (readOffset(part) === 0) lastSequenceStart.set(objectId, pos);
      } else if (writeKind(part) === "replace") {
        lastWrite.set(objectId, pos);
      }
    }
  }

  return { sourceParts, lastWrite, lastSequenceStart };
}

/**
 * Returns `messages` with every superseded workspace source payload stubbed.
 *
 * See `partsToKeep` for what counts as current. When nothing needs pruning the
 * original array is returned by reference, so the common case (a chat with no
 * workspace open, or a first edit) allocates nothing.
 */
export function pruneStaleWorkspaceToolPayloads(
  messages: UIMessage[]
): UIMessage[] {
  const keep = partsToKeep(messages);
  if (keep.size === 0) return messages;

  let anyChanged = false;
  const pruned = messages.map((message, m) => {
    const parts = message?.parts;
    if (!Array.isArray(parts)) return message;
    let messageChanged = false;
    const nextParts = parts.map((part, p) => {
      if (!isWorkspaceSourceToolPart(part)) return part;
      if (keep.has(`${m}:${p}`)) return part;
      const next = prunePart(part);
      if (next !== part) messageChanged = true;
      return next;
    });
    if (!messageChanged) return message;
    anyChanged = true;
    return { ...message, parts: nextParts as UIMessage["parts"] };
  });

  return anyChanged ? pruned : messages;
}
