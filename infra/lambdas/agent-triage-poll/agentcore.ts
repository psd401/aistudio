/**
 * AgentCore invocation for the @psd/Task user-gesture path.
 *
 * The classifier Lambda hands off to the user's agent (per their MEMORY.md
 * instructions and loaded skills) to actually create the task in whatever
 * task system they prefer. We just deliver the email metadata in a
 * structured prompt the agent already knows how to handle (per the user's
 * memory entry titled "Email Triage → Life OS Task Creation" or
 * equivalent).
 *
 * The reply contract is intentionally tiny:
 *   Created life-os issue #<n>: <title>     ← success
 *   FAILED: <reason>                         ← failure
 *
 * Anything else gets classified as "unparseable" and treated like a
 * failure. The agent's MEMORY.md instructions are responsible for
 * enforcing this format.
 */

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

import { fetchTaskInstructions } from "./memory";

/**
 * Hard wall-clock budget for a single AgentCore invocation. Without this
 * the SDK call can hang up to the Lambda's 5-minute timeout, which kills
 * the whole tick mid-flight (cursor doesn't advance, gestures replay
 * forever — observed 2026-05-22). 90 seconds is enough for the agent
 * to read the prompt, run one `gh issue create`, and reply.
 */
const AGENTCORE_INVOKE_TIMEOUT_MS = 90_000;

const REGION = process.env.AWS_REGION ?? "us-east-1";
const ENVIRONMENT = process.env.ENVIRONMENT ?? "dev";

let cached: BedrockAgentCoreClient | null = null;
function client(): BedrockAgentCoreClient {
  if (!cached) cached = new BedrockAgentCoreClient({ region: REGION });
  return cached;
}

let cachedRuntimeId: string | null = null;
let cachedAt = 0;
const RUNTIME_ID_TTL_MS = 5 * 60 * 1000; // 5-minute cache; matches router pattern

/**
 * Resolve the AgentCore Runtime ID. Tries (in order):
 *   1. AGENTCORE_RUNTIME_ID env var (if set explicitly at deploy time)
 *   2. SSM parameter /aistudio/<env>/agentcore-runtime-id
 *   3. cached value from a previous call within TTL
 *
 * Returns null if neither source produces a value — caller treats that
 * as a configuration error and surfaces FAILED to the user.
 */
async function resolveRuntimeId(): Promise<string | null> {
  if (process.env.AGENTCORE_RUNTIME_ID) {
    return process.env.AGENTCORE_RUNTIME_ID;
  }
  if (cachedRuntimeId && Date.now() - cachedAt < RUNTIME_ID_TTL_MS) {
    return cachedRuntimeId;
  }
  try {
    const ssm = new SSMClient({ region: REGION });
    const resp = await ssm.send(
      new GetParameterCommand({
        Name: `/aistudio/${ENVIRONMENT}/agentcore-runtime-id`,
      }),
    );
    const value = resp.Parameter?.Value ?? "";
    if (value) {
      cachedRuntimeId = value;
      cachedAt = Date.now();
      return value;
    }
  } catch {
    /* parameter missing — caller surfaces error */
  }
  return null;
}

export interface TaskCreationContext {
  userEmail: string;
  workspacePrefix: string;
  agentcoreRuntimeId?: string;
  subject: string;
  fromEmail: string;
  snippet: string;
  threadId: string;
  messageId: string;
}

export type TaskCreationResult =
  | { ok: true; taskRef: string; rawReply: string }
  | { ok: false; reason: string; rawReply: string };

const SUCCESS_PATTERN = /Created\s+([^\s#]+(?:\s+[^\s#]+)*?)\s+(?:issue|task)\s+(#?\w+[\w/-]*)\s*:?\s*(.+)?/i;
// Looser fallback: "Created <anything>: <title>" with no id. Captures the
// title as the taskRef so downstream still has something to display.
const SUCCESS_FALLBACK_PATTERN = /Created\s+(.+?)\s*:\s*(.+)$/i;
const FAILED_PATTERN = /FAILED:\s*(.+?)\s*$/im;

/**
 * Build the session ID for an AgentCore invocation.
 *
 * AgentCore requires session IDs of length [33, 64]. We use:
 *   <prefix-up-to-30>-task-<full-messageId-16hex>-<unix-ms-13digits>
 * which is reliably 35-65 chars and gives every gesture a unique
 * session (no context bleed between distinct task creations).
 *
 * Includes the full 13-digit unix-ms timestamp so back-to-back
 * gestures within the same second still get distinct sessions.
 */
function buildSessionId(workspacePrefix: string, messageId: string): string {
  const prefix = (workspacePrefix || "unknown").slice(0, 30);
  const mid = (messageId || "00000000").slice(0, 16);
  const ts = Date.now().toString();
  const id = `${prefix}-task-${mid}-${ts}`;
  // Floor + ceiling. The cron Lambda has hit the upper bound before
  // when usernames + prefixes balloon; same guards here.
  if (id.length < 33) {
    // Pad with the message id again to ensure minimum length is met.
    return `${id}-${mid}`.slice(0, 64);
  }
  return id.slice(0, 64);
}

function buildPrompt(ctx: TaskCreationContext, userInstructions: string): string {
  // SELF-CONTAINED prompt. We do NOT depend on MEMORY.md or AGENTS.md
  // being loaded — agents may gate those files on "main session only"
  // heuristics that exclude programmatic invocations like this one.
  // Everything the agent needs to act on this request is embedded
  // below. If the agent later cross-references MEMORY.md for richer
  // context (label conventions, repo defaults), that's a bonus, not
  // a requirement.
  //
  // The tag at the top is the agent's recognition signal for any
  // out-of-band per-user logic the user has configured to refine the
  // default behavior (e.g. extra labels, target repo override).
  // Deliver the email metadata + the user's OWN task-creation
  // instructions (pulled from their MEMORY.md by the Lambda). NOTHING
  // about which task system to use lives in this file — that's the
  // user's call, expressed in their MEMORY.md.
  return [
    "[psd-email-triage task request]",
    "",
    "The user labeled this email as a task. Follow the YOUR INSTRUCTIONS",
    "block below EXACTLY — it's the user's own configuration. Do not",
    "substitute a different task system. Do not read MEMORY.md or any",
    "other file first; the relevant section is already inlined below.",
    "Then reply with ONE line per the REPLY FORMAT.",
    "",
    "===== YOUR INSTRUCTIONS (verbatim from the user's MEMORY.md) =====",
    userInstructions,
    "===== END INSTRUCTIONS =====",
    "",
    "EMAIL:",
    `  Subject: ${ctx.subject}`,
    `  From: ${ctx.fromEmail}`,
    `  Gmail link: https://mail.google.com/mail/u/0/#all/${ctx.messageId}`,
    `  Thread ID: ${ctx.threadId}`,
    `  Message ID: ${ctx.messageId}`,
    "  Body:",
    ctx.snippet.slice(0, 4000),
    "",
    "REPLY — exactly one line, no markdown, no preamble:",
    "  Created <ref>: <title>      ← on success (ref can be a URL, id, anything you choose)",
    "  FAILED: <one-sentence reason>",
    "",
    "Do not ask follow-up questions. Do not respond conversationally.",
    "Anything other than these two formats is treated as failure.",
  ].join("\n");
}

export async function requestTaskCreation(
  ctx: TaskCreationContext,
): Promise<TaskCreationResult> {
  const runtimeId = ctx.agentcoreRuntimeId || (await resolveRuntimeId());
  if (!runtimeId) {
    return {
      ok: false,
      reason: "AGENTCORE_RUNTIME_ID not configured (env or SSM)",
      rawReply: "",
    };
  }

  // Pull the user's task-creation instructions from their MEMORY.md. If
  // they haven't written a section for this, fail fast with a clear
  // message — don't let the agent guess.
  const userInstructions = await fetchTaskInstructions(ctx.workspacePrefix);
  if (!userInstructions) {
    return {
      ok: false,
      reason:
        "No task-creation instructions found in your MEMORY.md. Add a section titled '## Email Triage → Task Creation' with the exact command to run.",
      rawReply: "",
    };
  }

  const sessionId = buildSessionId(ctx.workspacePrefix, ctx.messageId);
  const prompt = buildPrompt(ctx, userInstructions);

  const cmd = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: runtimeId.startsWith("arn:")
      ? runtimeId
      : `arn:aws:bedrock-agentcore:${REGION}:${process.env.AWS_ACCOUNT ?? ""}:runtime/${runtimeId}`,
    runtimeSessionId: sessionId,
    payload: new TextEncoder().encode(
      JSON.stringify({
        prompt,
        // Field names match agentcore_wrapper.py's `invoke()` payload
        // contract (see agent-image/agentcore_wrapper.py).
        user_email: ctx.userEmail,
        workspace_prefix: ctx.workspacePrefix,
      }),
    ),
    qualifier: "DEFAULT",
  });

  // Hard timeout via AbortController. The SDK call itself doesn't honor
  // it for streaming, so we also race the consumer loop against a timer.
  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    AGENTCORE_INVOKE_TIMEOUT_MS,
  );
  let raw = "";
  try {
    const resp = await client().send(cmd, { abortSignal: controller.signal });
    if (resp.response) {
      const stream = resp.response as AsyncIterable<Uint8Array>;
      const decoder = new TextDecoder();
      const deadline = Date.now() + AGENTCORE_INVOKE_TIMEOUT_MS;
      for await (const chunk of stream) {
        raw += decoder.decode(chunk, { stream: true });
        if (Date.now() > deadline) {
          controller.abort();
          return {
            ok: false,
            reason: `AgentCore invocation timed out after ${AGENTCORE_INVOKE_TIMEOUT_MS / 1000}s`,
            rawReply: raw,
          };
        }
      }
      raw += decoder.decode();
    } else if ("statusCode" in (resp as object)) {
      const maybeBody = (resp as unknown as { payload?: Uint8Array }).payload;
      if (maybeBody) raw = new TextDecoder().decode(maybeBody);
    }
  } catch (err) {
    return {
      ok: false,
      reason: `AgentCore invocation error: ${err instanceof Error ? err.message : String(err)}`,
      rawReply: raw,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }

  return parseAgentReply(raw);
}

/**
 * Parse the agent's reply for either:
 *   Created <system> issue #<n>: <title>
 *   Created <system> task <id>: <title>
 *   FAILED: <reason>
 *
 * Tolerant of:
 *   - AgentCore SSE streaming: `data: {...}\n\ndata: {...}\n\n...`
 *     with intermediate heartbeats and a final `{"result": "..."}` event.
 *   - JSON envelope wrapping like `{"result": "...", "message": "..."}`.
 *   - Markdown code-fence wrappers.
 *   - Conversational replies — we scan all text content for any line
 *     matching the success or failure pattern; first match wins.
 */
export function parseAgentReply(raw: string): TaskCreationResult {
  if (!raw || !raw.trim()) {
    return { ok: false, reason: "empty agent reply", rawReply: raw };
  }

  // Extract all text content from the reply, walking SSE → JSON
  // → plain. We're tolerant because AgentCore's response shape is
  // moving target across runtime versions.
  const bodies = extractBodies(raw);

  // First pass: look for explicit FAILED or Created patterns in any
  // body line. First match wins (within a body), bodies in order of
  // discovery (which is the order AgentCore emitted them).
  for (const body of bodies) {
    for (const line of body.split(/\r?\n/)) {
      const failMatch = line.match(FAILED_PATTERN);
      if (failMatch) {
        return { ok: false, reason: failMatch[1].trim(), rawReply: raw };
      }
      const okMatch = line.match(SUCCESS_PATTERN);
      if (okMatch) {
        const taskRef = (okMatch[2] ?? "").trim();
        return { ok: true, taskRef, rawReply: raw };
      }
    }
  }
  // Second pass: loose "Created X: title" with no id.
  for (const body of bodies) {
    for (const line of body.split(/\r?\n/)) {
      const okMatch = line.match(SUCCESS_FALLBACK_PATTERN);
      if (okMatch) {
        const taskRef = (okMatch[1] ?? "task").trim().slice(0, 64);
        return { ok: true, taskRef, rawReply: raw };
      }
    }
  }

  // No pattern match — return the last body's first 200 chars as the
  // failure reason. That's typically the agent's prose explaining
  // why it didn't (or couldn't) follow the contract.
  const lastBody = bodies[bodies.length - 1] ?? "";
  return {
    ok: false,
    reason: `unparseable agent reply: ${lastBody.slice(0, 200) || raw.slice(0, 200)}`,
    rawReply: raw,
  };
}

/**
 * Walk the raw reply and pull out every text body we can find. Handles:
 *   - Raw text → returned as-is
 *   - Single JSON object → result/message/reply field extracted
 *   - SSE stream (`data: {...}\n\n`) → each event's result/message
 *     extracted in order
 *   - Markdown code-fence wrappers stripped
 */
function extractBodies(raw: string): string[] {
  const bodies: string[] = [];

  // Detect SSE format: at least one line starts with `data: `.
  const sseLines = raw.match(/^data:\s.+$/gm);
  if (sseLines && sseLines.length > 0) {
    for (const line of sseLines) {
      const payload = line.replace(/^data:\s/, "").trim();
      // The terminating `[DONE]` sentinel is from OpenAI-style streams;
      // AgentCore doesn't use it but be safe.
      if (payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload);
        const text =
          (obj as { result?: string }).result ??
          (obj as { message?: string }).message ??
          (obj as { reply?: string }).reply ??
          (obj as { content?: string }).content;
        if (typeof text === "string" && text.trim()) {
          bodies.push(stripFences(text));
        }
      } catch {
        // Non-JSON SSE event; ignore.
      }
    }
    if (bodies.length > 0) return bodies;
  }

  // Try the whole thing as a single JSON envelope.
  try {
    const obj = JSON.parse(raw.trim());
    if (obj && typeof obj === "object") {
      const text =
        (obj as { result?: string }).result ??
        (obj as { message?: string }).message ??
        (obj as { reply?: string }).reply ??
        (obj as { content?: string }).content;
      if (typeof text === "string") return [stripFences(text)];
    }
  } catch {
    /* not JSON */
  }

  // Plain text — return as-is, with any code-fence wrapping stripped.
  return [stripFences(raw)];
}

function stripFences(s: string): string {
  return s
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}
