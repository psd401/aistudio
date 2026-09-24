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
 * Returns `messages` with every superseded workspace source payload stubbed.
 *
 * The newest workspace source tool part is left verbatim. When nothing needs
 * pruning the original array is returned by reference, so the common case (a
 * chat with no workspace open, or a first edit) allocates nothing.
 */
export function pruneStaleWorkspaceToolPayloads(
  messages: UIMessage[]
): UIMessage[] {
  // Locate the newest workspace source part; everything before it is stale.
  let latestMessageIndex = -1;
  let latestPartIndex = -1;
  for (const [m, message] of messages.entries()) {
    const parts = message?.parts;
    if (!Array.isArray(parts)) continue;
    for (const [p, part] of parts.entries()) {
      if (isWorkspaceSourceToolPart(part)) {
        latestMessageIndex = m;
        latestPartIndex = p;
      }
    }
  }
  // Fewer than two workspace source parts means there is nothing superseded.
  if (latestMessageIndex < 0) return messages;

  let anyChanged = false;
  const pruned = messages.map((message, m) => {
    const parts = message?.parts;
    if (!Array.isArray(parts)) return message;
    let messageChanged = false;
    const nextParts = parts.map((part, p) => {
      if (!isWorkspaceSourceToolPart(part)) return part;
      if (m === latestMessageIndex && p === latestPartIndex) return part;
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
