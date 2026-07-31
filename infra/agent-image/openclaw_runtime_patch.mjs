#!/usr/bin/env node

/**
 * Narrow backports for the pinned OpenClaw 2026.7.2-beta.5 runtime.
 *
 * The base image predates two upstream fixes:
 * - openclaw/openclaw#115452 preserves caller-owned in-memory session managers
 *   used by setup/config-expert inference probes.
 * - openclaw/openclaw#115474 adopts an ingress-persisted user turn instead of
 *   appending a second physical SQLite event for the same idempotency key.
 *
 * OpenClaw ships compiled, content-hashed bundles. Patch semantic anchors and
 * fail the image build unless every expected beta.5 anchor occurs exactly
 * once; a future host bump must remove or deliberately refresh this backport.
 * This is deliberately single-shot: running it twice fails on missing original
 * anchors, which catches duplicate Dockerfile invocation instead of masking it.
 */

import fs from "node:fs";
import path from "node:path";

const EXPECTED_OPENCLAW_VERSION = "2026.7.2-beta.5";
const distDir = path.resolve(process.argv[2] ?? "/app/dist");
const packagePath = path.join(path.dirname(distDir), "package.json");

function fail(message) {
  throw new Error(`OpenClaw runtime patch failed: ${message}`);
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0) {
    fail(`${label}: expected anchor was not found`);
  }
  if (source.includes(before, first + before.length)) {
    fail(`${label}: expected anchor occurred more than once`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function findUniqueBundle(files, label, markers) {
  const matches = files.filter((file) => {
    const source = file.source;
    return markers.every((marker) => source.includes(marker));
  });
  if (matches.length !== 1) {
    fail(`${label}: expected one bundle, found ${matches.length}`);
  }
  return matches[0];
}

// Build-only path: the Dockerfile supplies the immutable /app/dist directory.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
if (
  packageJson.name !== "openclaw" ||
  packageJson.version !== EXPECTED_OPENCLAW_VERSION
) {
  fail(
    `expected openclaw ${EXPECTED_OPENCLAW_VERSION}, found ` +
      `${String(packageJson.name)} ${String(packageJson.version)}`,
  );
}

// eslint-disable-next-line security/detect-non-literal-fs-filename
const files = fs
  .readdirSync(distDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => {
    const filePath = path.join(distDir, name);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return { name, filePath, source: fs.readFileSync(filePath, "utf8") };
  });

const embeddedAgent = findUniqueBundle(files, "caller-owned session manager", [
  "function dispatchEmbeddedRunAttempt(input)",
  "sessionTarget: runtime.sessionTarget",
]);
embeddedAgent.source = replaceOnce(
  embeddedAgent.source,
  "\t\tsessionTarget: runtime.sessionTarget,",
  "\t\tsessionManager: params.sessionManager,\n" +
    "\t\tsessionTarget: params.sessionManager ? void 0 : runtime.sessionTarget,",
  "preserve setup inference session manager",
);

const agentCommand = findUniqueBundle(files, "ingress transcript recorder", [
  "async function runEmbeddedAgentAttempt(params)",
  "const userTurnTranscriptRecorder = createUserTurnTranscriptRecorder",
]);
agentCommand.source = replaceOnce(
  agentCommand.source,
  "\tconst userTurnTranscriptRecorder = createUserTurnTranscriptRecorder({",
  "\tconst userTurnTranscriptRecorder = " +
    "(internalSessionTarget ? void 0 : params.opts.userTurnTranscriptRecorder) " +
    "?? createUserTurnTranscriptRecorder({",
  "reuse ingress transcript recorder",
);

const sessionManager = findUniqueBundle(files, "session manager idempotency", [
  "class extends SessionManagerPersistence",
  "let result = appendSqliteTranscriptMessageSync(scope, appendOptions)",
]);
sessionManager.source = replaceOnce(
  sessionManager.source,
  [
    "\t\tlet result = appendSqliteTranscriptMessageSync(scope, appendOptions);",
    "\t\tif (result && !result.appended && result.messageId !== entry.id) result = appendSqliteTranscriptMessageSync(scope, {",
    "\t\t\t...appendOptions,",
    '\t\t\tidempotencyLookup: "caller-checked"',
    "\t\t});",
  ].join("\n"),
  "\t\tconst result = appendSqliteTranscriptMessageSync(scope, appendOptions);",
  "remove forced duplicate SQLite append",
);
sessionManager.source = replaceOnce(
  sessionManager.source,
  [
    "\tappendMessage(message, options) {",
    "\t\tconst entry = {",
  ].join("\n"),
  [
    "\tappendMessage(message, options) {",
    '\t\tif (options?.idempotencyLookup !== "caller-checked" && message.role === "user" && typeof message.idempotencyKey === "string" && message.idempotencyKey.length > 0) {',
    "\t\t\tlet parent = this.appendParentId ? this.byId.get(this.appendParentId) : void 0;",
    "\t\t\tlet remainingAncestors = this.byId.size;",
    '\t\t\twhile (parent && remainingAncestors-- > 0 && (parent.type === "thinking_level_change" || parent.type === "model_change" || parent.type === "custom" || parent.type === "label" || parent.type === "session_info")) parent = parent.parentId ? this.byId.get(parent.parentId) : void 0;',
    '\t\t\tif (parent?.type === "message" && parent.message.role === "user" && parent.message.idempotencyKey === message.idempotencyKey) return parent.id;',
    "\t\t}",
    "\t\tconst entry = {",
  ].join("\n"),
  "adopt ingress-persisted user turn",
);

const guardWrapper = findUniqueBundle(files, "session guard idempotency", [
  "function guardSessionManager(sessionManager, opts)",
  "const parentEntryId = sessionManager.getLeafId()",
]);
guardWrapper.source = replaceOnce(
  guardWrapper.source,
  [
    "\t\tconst parentEntryId = sessionManager.getLeafId();",
    "\t\tconst entryId = originalAppend(message, options);",
    "\t\topts?.onMessagePersisted?.(message);",
  ].join("\n"),
  [
    "\t\tconst parentEntryId = sessionManager.getLeafId();",
    "\t\tconst appendParentEntryId = sessionManager.getAppendParentId();",
    "\t\tconst entryId = originalAppend(message, options);",
    "\t\tif (sessionManager.getAppendParentId() === appendParentEntryId) return { entryId };",
    "\t\topts?.onMessagePersisted?.(message);",
  ].join("\n"),
  "suppress duplicate transcript update",
);
guardWrapper.source = replaceOnce(
  guardWrapper.source,
  [
    "\t\t\tconst runtimeContext = takeRuntimeUserTurnTranscriptContext(message);",
    "\t\t\tconst prepared = runtimeContext?.message ?? pendingPreparedUserTurnMessage;",
    '\t\t\tif (message.role === "user") opts?.onUserMessagePreparingForPersistence?.(message, runtimeContext?.recorder, prepared);',
    "\t\t\tconst merged = mergePreparedUserTurnMessageForRuntime({",
    "\t\t\t\truntimeMessage: withProvenance,",
    "\t\t\t\t...prepared ? { preparedMessage: prepared } : {}",
    "\t\t\t});",
    "\t\t\tif (merged !== withProvenance) if (runtimeContext) queuedUserTurnTranscriptRecorder = runtimeContext.recorder;",
    "\t\t\telse pendingPreparedUserTurnMessage = void 0;",
  ].join("\n"),
  [
    "\t\t\tconst runtimeContext = takeRuntimeUserTurnTranscriptContext(message);",
    "\t\t\tconst prepared = runtimeContext?.message ?? pendingPreparedUserTurnMessage;",
    "\t\t\tconst recorder = runtimeContext?.recorder ?? (prepared !== void 0 && prepared === pendingPreparedUserTurnMessage ? opts?.preparedUserTurnTranscriptRecorder : void 0);",
    '\t\t\tif (message.role === "user") opts?.onUserMessagePreparingForPersistence?.(message, recorder, prepared);',
    "\t\t\tconst merged = mergePreparedUserTurnMessageForRuntime({",
    "\t\t\t\truntimeMessage: withProvenance,",
    "\t\t\t\t...prepared ? { preparedMessage: prepared } : {}",
    "\t\t\t});",
    "\t\t\tif (merged !== withProvenance) {",
    "\t\t\t\tqueuedUserTurnTranscriptRecorder = recorder;",
    "\t\t\t\tif (!runtimeContext) pendingPreparedUserTurnMessage = void 0;",
    "\t\t\t}",
  ].join("\n"),
  "retain prepared user turn recorder",
);

const selection = findUniqueBundle(files, "embedded attempt transcript wiring", [
  "function prepareEmbeddedAttemptSessionManager(input)",
  "function detachPrePersistedCurrentUserTurn(params)",
]);
selection.source = replaceOnce(
  selection.source,
  [
    "\t\tinputProvenance: attempt.inputProvenance,",
    "\t\tpreparedUserTurnMessage,",
    "\t\tallowSyntheticToolResults:",
  ].join("\n"),
  [
    "\t\tinputProvenance: attempt.inputProvenance,",
    "\t\tpreparedUserTurnMessage,",
    "\t\tpreparedUserTurnTranscriptRecorder: preparedUserTurnMessage ? attempt.userTurnTranscriptRecorder : void 0,",
    "\t\tallowSyntheticToolResults:",
  ].join("\n"),
  "wire prepared user turn recorder",
);
selection.source = replaceOnce(
  selection.source,
  "\tif (!params.suppressNextUserMessagePersistence || !params.userTurnAlreadyPersisted) return false;",
  "\tif (!params.userTurnAlreadyPersisted) return false;",
  "detach pre-persisted runtime user",
);
selection.source = replaceOnce(
  selection.source,
  [
    "\tconst orphanRepair = preserveExactPrompt ? void 0 : resolveOrphanRepairPlan({",
    "\t\tsessionManager,",
    "\t\tprompt: attempt.prompt,",
    "\t\ttrigger: attempt.trigger",
    "\t});",
    "\tif (orphanRepair?.removeLeaf) {",
    "\t\tif (orphanRepair.messageEntry.parentId) sessionManager.branch(orphanRepair.messageEntry.parentId);",
    "\t\telse sessionManager.resetLeaf();",
    "\t\treplayTrailingEntriesForOrphanRepair(sessionManager, orphanRepair.trailingEntries);",
    "\t\tsessionManager.clearNextUserMessagePersistenceSuppression?.();",
    "\t\tattempt.onUserMessagePersistenceInvalidated?.();",
    "\t\tactiveSession.agent.state.messages = sessionManager.buildSessionContext().messages;",
    "\t}",
    "\tdetachPrePersistedCurrentUserTurn({",
    "\t\tactiveSession,",
    "\t\tpreparedUserTurnMessage: input.preparedUserTurnMessage,",
    "\t\tsuppressNextUserMessagePersistence: attempt.suppressNextUserMessagePersistence,",
    "\t\tuserTurnAlreadyPersisted: attempt.userTurnTranscriptRecorder?.hasPersisted() === true",
    "\t});",
  ].join("\n"),
  [
    "\tconst detachedCurrentUser = !preserveExactPrompt && detachPrePersistedCurrentUserTurn({",
    "\t\tactiveSession,",
    "\t\tpreparedUserTurnMessage: input.preparedUserTurnMessage,",
    "\t\tuserTurnAlreadyPersisted: attempt.userTurnTranscriptRecorder?.hasPersisted() === true",
    "\t});",
    "\tconst orphanRepair = preserveExactPrompt || detachedCurrentUser ? void 0 : resolveOrphanRepairPlan({",
    "\t\tsessionManager,",
    "\t\tprompt: attempt.prompt,",
    "\t\ttrigger: attempt.trigger",
    "\t});",
    "\tif (orphanRepair?.removeLeaf) {",
    "\t\tif (orphanRepair.messageEntry.parentId) sessionManager.branch(orphanRepair.messageEntry.parentId);",
    "\t\telse sessionManager.resetLeaf();",
    "\t\treplayTrailingEntriesForOrphanRepair(sessionManager, orphanRepair.trailingEntries);",
    "\t\tsessionManager.clearNextUserMessagePersistenceSuppression?.();",
    "\t\tattempt.onUserMessagePersistenceInvalidated?.();",
    "\t\tactiveSession.agent.state.messages = sessionManager.buildSessionContext().messages;",
    "\t}",
  ].join("\n"),
  "detach ingress user before orphan repair",
);

for (const file of [
  embeddedAgent,
  agentCommand,
  sessionManager,
  guardWrapper,
  selection,
]) {
  // filePath is confined to the enumerated, version-checked dist directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  fs.writeFileSync(file.filePath, file.source);
}

process.stdout.write(
  `Patched OpenClaw ${EXPECTED_OPENCLAW_VERSION}: ` +
    [embeddedAgent, agentCommand, sessionManager, guardWrapper, selection]
      .map((file) => file.name)
      .join(", ") +
    "\n",
);
