/**
 * Atrium agent bridge endpoint (#1051)
 *
 * POST /api/content/[id]/agent-bridge — lets an agent act on the live collaborative
 * document, attributed to the agent (purple rail). This is the rebuilt equivalent
 * of Proof's bridge: the `X-Agent-Id` header maps to the agent label stamped on the
 * rail, and the change diffs into the same Y.Doc connected editors hold.
 *
 * Ops (§18.1) via the optional `op` discriminator — the op is OPTIONAL and, when
 * absent, the request behaves exactly as before (markdown push):
 *   - `replace` / `append` (default): rewrite / append markdown, authored by the agent.
 *   - `comment`: anchor a comment thread (AtriumComment mark) over a quoted span and
 *     write the thread root to `atrium_doc_comments`.
 *   - `suggest`: propose an insertion / deletion (track-changes suggestion marks) for
 *     a human to accept or reject — NOT a direct rewrite.
 *   - `publish` / `unpublish`: take the object's working head live at a destination
 *     (default `intranet`) — or take it offline — through the SAME `publishService`
 *     gate humans use (canView 404-mask → canEdit → §26.4 public-destination
 *     approval). These ops author NO new text, so they skip the guardrails/PII
 *     screening and the `X-Agent-Id` attribution the write ops carry. A public
 *     destination the caller may not publish directly returns 202 (queued for
 *     approval), never a silent bypass.
 *
 * Safety (spec §28.3): the agent-authored text of EVERY op (markdown / comment body /
 * suggestion text) is screened by Bedrock Guardrails (blocked content is rejected,
 * never persisted) and scanned for PII (logged as telemetry — document content is NOT
 * tokenized, since a published document must keep its real text) BEFORE it touches the
 * document. The screening core lives in `lib/content/agent-screening.ts` (shared with
 * `contentService.create` / `versionService.snapshot`); this route only maps its verdict
 * to HTTP.
 *
 * Auth (Phase 1): a logged-in human with edit rights on the object operates the
 * agent; the session is the authorization conduit and the X-Agent-Id is the
 * attribution. (Autonomous-agent auth via API keys is a later phase.)
 */

import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createLogger, generateRequestId, startTimer } from "@/lib/logger";
import { getServerSession } from "@/lib/auth/server-session";
import { getUserRequester } from "@/actions/db/atrium/requester";
import { contentService } from "@/lib/content/content-service";
import { visibilityService } from "@/lib/content/visibility-service";
import { canEdit } from "@/lib/content/helpers";
import { screenAgentContent } from "@/lib/content/agent-screening";
import { publishService } from "@/lib/content/publish-service";
import { assertEditorDestination } from "@/lib/content/validators";
import { mapAgentPublishError } from "@/lib/content/agent-publish-response";
import { executeQuery } from "@/lib/db/drizzle-client";
import { agentIdentities } from "@/lib/db/schema";
import {
  applyAgentEdit,
  applyAgentComment,
  applyAgentSuggestion,
  QuoteNotLocatedError,
  type AgentEditMode,
} from "@/lib/content/collab/apply-agent-edit";
import { snapshotLiveDocumentForPublish } from "@/lib/content/collab/snapshot-before-publish";

/** UUID v4-ish shape — the form `agent_identities.id` takes (defaultRandom()). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per-document in-process async serialization lock (keyed on objectId).
 *
 * In "append" mode the screen→apply sequence reads the current doc state and
 * then writes new content. If two concurrent agent-bridge requests target the
 * SAME document, each could independently pass Bedrock Guardrails screening and
 * then both apply in overlapping CRDT transactions — a TOCTOU race that lets
 * combined content bypass the guardrail that reviewed each piece in isolation.
 *
 * This map chains each incoming request for a given objectId behind the
 * previous request's completion (a promise chain / async mutex). Only one
 * screen→apply sequence per document runs at a time within this ECS task.
 *
 * SCOPE: in-process only. Multiple ECS tasks do NOT share this lock; two tasks
 * handling concurrent requests for the same document can still race. Cross-task
 * serialization (e.g. a DynamoDB or Redis distributed lock) is a documented
 * Phase 2 concern and is NOT added here to avoid the operational complexity of
 * a Redis dependency (local dev has no Redis; it is optional).
 */
const _docLocks = new Map<string, Promise<void>>();

/**
 * Acquire the per-document lock, run `fn`, then release. Cleans up the map
 * entry when this call is the last in the chain so the map stays bounded.
 */
async function withDocumentLock<T>(objectId: string, fn: () => Promise<T>): Promise<T> {
  const prior = _docLocks.get(objectId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((res) => { release = res; });
  // Capture the chained promise in ONE variable: `prior.then(...)` returns a NEW
  // promise each call, so we must store the SAME reference we later identity-check
  // against — comparing two separate `.then()` results would never match, leaking
  // the map entry forever (unbounded growth for documents that stop receiving writes).
  const chained = prior.then(() => next);
  _docLocks.set(objectId, chained);
  try {
    await prior;
    return await fn();
  } finally {
    release();
    // Clean up only if our chained promise is still the current tail. A later
    // request for the same objectId would have replaced it (and chained behind
    // `next`), in which case we must NOT delete — that request owns the entry.
    if (_docLocks.get(objectId) === chained) {
      _docLocks.delete(objectId);
    }
  }
}


/**
 * Validate the attribution agent id. The `X-Agent-Id` header is stamped onto the
 * CRDT nodes the edit produces, so anything that trusts that mark (audit trail, UI
 * attribution, export) trusts this value.
 *
 * - A UUID-shaped id is treated as a claim of a registered `agent_identities` row:
 *   it MUST exist and be active, else we reject (403). This prevents spoofing
 *   `X-Agent-Id: <real-bot-uuid>`.
 * - A non-UUID free-form label (e.g. a registered agent's `name` like
 *   "ship-reporter", or an ad-hoc "drafting-agent") is accepted as-is.
 *
 * KNOWN LIMITATION (Phase 1, documented per PR #1062 review): the free-form-label
 * branch performs NO identity verification. Because `agent_identities.id` is a
 * `defaultRandom()` UUID not knowable at call sites, the legitimate way to attribute
 * an edit to a registered agent in Phase 1 IS its name — so any logged-in human with
 * edit rights can stamp `ai:<any-label>`, including the NAME of a registered agent.
 * This is acceptable for Phase 1 because the route's authorization model is "a
 * logged-in human with edit rights operates the agent; the session is the
 * authorization conduit and X-Agent-Id is attribution" (see route header) — it is
 * cosmetic, session-gated attribution, NOT authenticated agent identity. Autonomous
 * agents authenticating as themselves (binding a verified identity to the label via
 * API keys, which would let us reject by-name impersonation) arrive in a later phase.
 *
 * Returns true when the id may be used for attribution, false when it must be rejected.
 */
async function isAttributableAgentId(agentId: string): Promise<boolean> {
  if (!UUID_RE.test(agentId)) return true;
  const rows = await executeQuery(
    (db) =>
      db
        .select({ id: agentIdentities.id })
        .from(agentIdentities)
        .where(and(eq(agentIdentities.id, agentId), eq(agentIdentities.isActive, true)))
        .limit(1),
    "atrium.agentBridge.validateAgentId"
  );
  return rows.length > 0 && rows[0] != null;
}

/**
 * Bridge request body (§18.1). `op` discriminates the four agent operations; it is
 * OPTIONAL and, when absent, the request behaves exactly as before (`markdown` +
 * optional `mode` → replace/append) for back-compat. The op-specific fields are
 * validated per branch below (zod checks types/shape; required-field presence and
 * the shared byte-size / screening guards run in the handler). No max-length caps
 * are imposed here — the existing 512 KB guard (see handler) bounds screened text.
 */
const bridgeBodySchema = z.object({
  op: z
    .enum(["replace", "append", "comment", "suggest", "publish", "unpublish"])
    .optional(),
  markdown: z.string().optional(),
  mode: z.enum(["replace", "append"]).optional(),
  // comment op
  quote: z.string().optional(),
  body: z.string().optional(),
  threadId: z.string().uuid().optional(),
  // suggest op
  kind: z.enum(["insert", "delete"]).optional(),
  suggestionId: z.string().uuid().optional(),
  // publish / unpublish op — the destination is narrowed at runtime via
  // `assertEditorDestination` (rejects `okf` and unknown values). Defaults to
  // `intranet` (the safe internal reader) when omitted.
  destination: z.string().max(50).optional(),
});

type BridgeBody = z.infer<typeof bridgeBodySchema>;

/** Max byte size for any agent-authored text that gets screened. Bedrock Guardrails'
 *  internal limit is ~64 KB; oversized payloads degrade silently to "allowed", so
 *  cap the input well above legitimate use but below what would broadcast a huge
 *  Yjs update. Shared by every op (markdown, comment body, suggestion text). */
const MAX_SCREENED_BYTES = 512 * 1024;

/** Resolve the effective edit mode for the legacy (replace/append) path: an explicit
 *  `op` wins, else fall back to `mode`, else replace. */
function resolveEditMode(op: BridgeBody["op"], mode: BridgeBody["mode"]): AgentEditMode {
  if (op === "append") return "append";
  if (op === "replace") return "replace";
  return mode === "append" ? "append" : "replace";
}

/** Resolve the object and confirm the caller may edit it. Returns the object, or
 * a NextResponse to return on any failure (existence-masking 404 / 403). */
async function loadEditableObject(
  id: string,
  req: Awaited<ReturnType<typeof getUserRequester>>
): Promise<
  | { obj: { id: string; ownerUserId: number; kind: "document" | "artifact" } }
  | { error: NextResponse }
> {
  const obj = await contentService.loadByIdOrSlug(id);
  if (!obj) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  const viewable = await visibilityService.canView(req, {
    id: obj.id,
    ownerUserId: obj.ownerUserId,
    visibilityLevel: obj.visibilityLevel,
  });
  if (!viewable) return { error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  if (!canEdit(req, obj.ownerUserId)) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return {
    obj: { id: obj.id, ownerUserId: obj.ownerUserId, kind: obj.kind as "document" | "artifact" },
  };
}

/** Screen agent markdown via the shared §28.3 core (`lib/content/agent-screening`
 * — guardrails fail-OPEN + PII telemetry, logging included). `requestId` threads
 * this request's correlation onto the core's blocked log lines. This wrapper maps
 * the verdict to HTTP: 422 for a positive guardrails detection. A degraded
 * (unavailable) evaluation fails open in the core and never reaches here — the
 * write proceeds. Returns null to proceed. */
async function screenAgentMarkdown(
  markdown: string,
  objectId: string,
  requestId: string
): Promise<NextResponse | null> {
  const verdict = await screenAgentContent(markdown, objectId, requestId);
  if (verdict.allowed) return null;
  // Only a positive guardrails detection is non-allowed (degraded fails open).
  return NextResponse.json(
    { error: "Content blocked by safety policy", message: verdict.message },
    { status: 422 }
  );
}

/**
 * The concrete operation resolved from the request body, plus `screenText`: the
 * agent-authored text that must pass `screenAgentContent`. EVERY op contributes
 * screenText (comment body / suggestion text), so every op flows through the same
 * guardrails+PII gate — no op can smuggle unscreened agent text into the document.
 */
type BridgeAction =
  | { kind: "edit"; mode: AgentEditMode; markdown: string; screenText: string }
  | { kind: "comment"; quote: string; body: string; threadId?: string; screenText: string }
  | {
      kind: "suggest";
      suggestKind: "insert" | "delete";
      markdown?: string;
      quote?: string;
      suggestionId?: string;
      screenText: string;
    };

type ActionResult = { action: BridgeAction } | { error: NextResponse };

function tooLarge(text: string): boolean {
  return Buffer.byteLength(text, "utf8") > MAX_SCREENED_BYTES;
}

function missing(field: string): { error: NextResponse } {
  return { error: NextResponse.json({ error: `${field} is required` }, { status: 400 }) };
}

function tooLargeError(message = "content too large (max 512 KB)"): { error: NextResponse } {
  return { error: NextResponse.json({ error: message }, { status: 413 }) };
}

/** comment: anchor a thread on a quoted span. Screens the agent's comment body.
 *  The `quote` is checked non-empty but passed UN-trimmed so the exact-substring
 *  anchor match is preserved. */
function buildCommentAction(data: BridgeBody): ActionResult {
  const quote = data.quote ?? "";
  const body = data.body ?? "";
  if (!quote.trim()) return missing("quote");
  if (!body.trim()) return missing("body");
  if (tooLarge(body)) return tooLargeError();
  return { action: { kind: "comment", quote, body, threadId: data.threadId, screenText: body } };
}

/** suggest: propose an insertion (screen the markdown) or a deletion (screen the
 *  quote — the only agent-supplied text on a delete). */
function buildSuggestAction(data: BridgeBody): ActionResult {
  const kind = data.kind;
  if (!kind) return missing("kind (insert|delete)");
  if (kind === "insert") {
    const markdown = data.markdown ?? "";
    if (!markdown.trim()) return missing("markdown");
    if (tooLarge(markdown)) return tooLargeError();
    return {
      action: { kind: "suggest", suggestKind: "insert", markdown, suggestionId: data.suggestionId, screenText: markdown },
    };
  }
  const quote = data.quote ?? "";
  if (!quote.trim()) return missing("quote");
  if (tooLarge(quote)) return tooLargeError();
  return {
    action: { kind: "suggest", suggestKind: "delete", quote, suggestionId: data.suggestionId, screenText: quote },
  };
}

/**
 * Legacy path (op absent / "replace" / "append") — preserves the prior edit
 * SEMANTICS (the `mode`/`markdown` behavior is unchanged for back-compat). The
 * success envelope additionally echoes `op` now, so it is a superset of the prior
 * `{ applied, mode }` shape, not byte-identical.
 */
function buildEditAction(op: BridgeBody["op"], data: BridgeBody): ActionResult {
  const markdown = data.markdown ?? "";
  if (!markdown.trim()) return missing("markdown");
  if (tooLarge(markdown)) return tooLargeError("markdown too large (max 512 KB)");
  return { action: { kind: "edit", mode: resolveEditMode(op, data.mode), markdown, screenText: markdown } };
}

/**
 * Validate op-specific fields and resolve the concrete action + the text to screen.
 * Returns a NextResponse on any validation failure (400 missing field / 413 too
 * large). Runs BEFORE auth, mirroring the original markdown-required / too-large guards.
 */
function buildBridgeAction(op: BridgeBody["op"], data: BridgeBody): ActionResult {
  if (op === "comment") return buildCommentAction(data);
  if (op === "suggest") return buildSuggestAction(data);
  return buildEditAction(op, data);
}

/**
 * Handle the `publish` / `unpublish` ops. These author no new agent text, so they
 * bypass the guardrails/PII screening + `X-Agent-Id` attribution the write ops use
 * and go straight through `publishService`, which owns the full authorization gate
 * (canView 404-mask → canEdit → §26.4 public-destination approval). The acting
 * SESSION user's permissions decide: `req` is the delegated-human requester, so an
 * agent can only publish what its operator could publish by hand. A public
 * destination the operator may not publish directly surfaces as 202 (queued for
 * approval), never a silent bypass. `intranet` (the internal reader) is the default.
 */
interface PublishOpContext {
  id: string;
  op: "publish" | "unpublish";
  destinationRaw: string | undefined;
  req: Awaited<ReturnType<typeof getUserRequester>>;
  requestId: string;
  log: ReturnType<typeof createLogger>;
}

async function handlePublishOp(ctx: PublishOpContext): Promise<NextResponse> {
  const { id, op, destinationRaw, req, requestId, log } = ctx;
  // Resolve + authorize the object exactly like the write ops (canView 404 /
  // canEdit 403). publishService re-checks the same gate defensively.
  const loaded = await loadEditableObject(id, req);
  if ("error" in loaded) return loaded.error;
  const objectId = loaded.obj.id;

  let destination: ReturnType<typeof assertEditorDestination>;
  try {
    destination = assertEditorDestination(destinationRaw ?? "intranet", op);
  } catch (error) {
    const mapped = mapAgentPublishError(error, op, destinationRaw ?? "intranet");
    if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
    throw error;
  }

  try {
    if (op === "publish") {
      // Advance the version head to the live doc content first: agent writes land
      // only on the live Yjs/atrium_doc_state path, so publishing the persisted
      // head without this would ship the stale/empty version (Codex review P1).
      await snapshotLiveDocumentForPublish({ req, objectId, kind: loaded.obj.kind, requestId });
      const result = await publishService.publish(req, objectId, { destination });
      log.info("Agent published object", { objectId, destination });
      return NextResponse.json({
        applied: true,
        op: "publish",
        destination,
        publicationId: result.publicationId,
        publishedVersionId: result.publishedVersionId,
      });
    }
    const result = await publishService.unpublish(req, objectId, destination);
    log.info("Agent unpublished object", { objectId, destination });
    return NextResponse.json({
      applied: true,
      op: "unpublish",
      destination,
      unpublished: result.unpublished,
    });
  } catch (error) {
    // Error semantics (§26.4 approval → 202, defensive 404/403/400) live in the
    // jest-covered `mapAgentPublishError`; unmapped errors rethrow to a 500.
    const mapped = mapAgentPublishError(error, op, destination);
    if (mapped) {
      if (mapped.status === 202) {
        log.info("Agent publish requires approval", { objectId, destination, op });
      }
      return NextResponse.json(mapped.body, { status: mapped.status });
    }
    throw error;
  }
}

/**
 * Handle the write ops (`replace` / `append` / `comment` / `suggest`): validate the
 * op-specific fields, resolve + edit-gate the object, validate the `X-Agent-Id`
 * attribution, then screen→apply under the per-document lock. Extracted from
 * postHandler so the dispatcher stays under the cyclomatic-complexity budget; the
 * publish/unpublish ops are handled separately (they author no text).
 */
interface WriteOpContext {
  id: string;
  data: BridgeBody;
  session: Parameters<typeof getUserRequester>[1];
  request: NextRequest;
  requestId: string;
  timer: ReturnType<typeof startTimer>;
  log: ReturnType<typeof createLogger>;
}

async function handleWriteOp(ctx: WriteOpContext): Promise<NextResponse> {
  const { id, data, session, request, requestId, timer, log } = ctx;
  // Resolve the op into a concrete action + the agent-authored text to screen.
  // Op-specific required-field / size validation happens here (before auth).
  const built = buildBridgeAction(data.op, data);
  if ("error" in built) {
    timer({ status: "error" });
    return built.error;
  }
  const action = built.action;

  // Validate X-Agent-Id: it's stamped into every CRDT node and JWT sub.
  // An unbounded value would bloat the Y.Doc and could overflow JWT headers.
  const rawAgentId = (request.headers.get("x-agent-id") || "agent").trim();
  const agentId = /^[\w-]{1,128}$/.test(rawAgentId) ? rawAgentId : "agent";

  // Thread the already-resolved session so getUserRequester reuses it instead of
  // calling getServerSession() a second time (double JWT-verify per request).
  const req = await getUserRequester(requestId, session);
  const loaded = await loadEditableObject(id, req);
  if ("error" in loaded) {
    timer({ status: "error" });
    return loaded.error;
  }
  const objectId = loaded.obj.id;

  // Validate attribution AFTER the edit-rights gate so a caller without edit
  // rights can't probe which agent_identities ids exist. A UUID-shaped id must
  // map to an active registered identity; spoofing a real bot's uuid is rejected.
  if (!(await isAttributableAgentId(agentId))) {
    log.warn("Agent write rejected: unknown/inactive agent identity", { objectId });
    timer({ status: "error" });
    return NextResponse.json({ error: "Unknown agent identity" }, { status: 403 });
  }

  // Serialize screen→apply for this document to prevent a TOCTOU race:
  // two concurrent requests could each pass Bedrock Guardrails independently and
  // then both apply in overlapping CRDT transactions, letting their combined
  // content bypass the guardrail that reviewed each in isolation. withDocumentLock
  // ensures only one screen→apply sequence runs per objectId at a time within this
  // ECS task. See the _docLocks comment for cross-task scope. ALL ops (edit,
  // comment, suggest) run inside it — the comment body / suggestion text is
  // screened the same way as a replace/append markdown payload.
  const result = await withDocumentLock(objectId, async (): Promise<{
    ok: boolean;
    response: NextResponse;
  }> => {
    const blocked = await screenAgentMarkdown(action.screenText, objectId, requestId);
    if (blocked) return { ok: false, response: blocked };

    switch (action.kind) {
      case "edit": {
        await applyAgentEdit({ objectId, markdown: action.markdown, agentId, mode: action.mode });
        return {
          ok: true,
          response: NextResponse.json({ applied: true, op: action.mode, mode: action.mode }),
        };
      }
      case "comment": {
        const { threadId } = await applyAgentComment({
          objectId,
          agentId,
          quote: action.quote,
          body: action.body,
          threadId: action.threadId,
        });
        return { ok: true, response: NextResponse.json({ applied: true, op: "comment", threadId }) };
      }
      case "suggest": {
        const { suggestionId } = await applyAgentSuggestion({
          objectId,
          agentId,
          kind: action.suggestKind,
          markdown: action.markdown,
          quote: action.quote,
          suggestionId: action.suggestionId,
        });
        return {
          ok: true,
          response: NextResponse.json({
            applied: true,
            op: "suggest",
            kind: action.suggestKind,
            suggestionId,
          }),
        };
      }
    }
  });

  if (!result.ok) {
    // screenAgentMarkdown returned a blocked (422) response inside the lock.
    timer({ status: "error" });
    return result.response;
  }

  timer({ status: "success" });
  log.info("Applied agent op", { objectId, agentId, op: action.kind });
  return result.response;
}

async function postHandler(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = generateRequestId();
  const timer = startTimer("POST /api/content/[id]/agent-bridge");
  const log = createLogger({ requestId, endpoint: "POST /api/content/[id]/agent-bridge" });

  try {
    const { id } = await params;

    const session = await getServerSession();
    if (!session?.sub) {
      timer({ status: "error" });
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // `request.json()` can resolve to `null` (valid JSON) — coerce to {} so the
    // schema validates an empty body instead of throwing on `null`.
    const raw = (await request.json().catch(() => ({}))) ?? {};
    const parsed = bridgeBodySchema.safeParse(raw);
    if (!parsed.success) {
      timer({ status: "error" });
      return NextResponse.json(
        { error: "Invalid request body", issues: parsed.error.issues },
        { status: 400 }
      );
    }
    const data = parsed.data;

    // Publish / unpublish author no new text — handle them through publishService's
    // own gate (canView/canEdit/§26.4) before the screening + attribution machinery
    // the write ops need. The session user is the authorization conduit (delegated).
    if (data.op === "publish" || data.op === "unpublish") {
      const req = await getUserRequester(requestId, session);
      const response = await handlePublishOp({
        id,
        op: data.op,
        destinationRaw: data.destination,
        req,
        requestId,
        log,
      });
      timer({ status: response.status >= 400 ? "error" : "success" });
      return response;
    }

    return handleWriteOp({ id, data, session, request, requestId, timer, log });
  } catch (error) {
    // A comment / suggest:delete whose quote is absent surfaces as this typed
    // error — the client sent a stale/unmatched anchor, so map it to 422 (not 500).
    if (error instanceof QuoteNotLocatedError) {
      timer({ status: "error" });
      log.warn("Agent bridge: quoted anchor not found in document");
      return NextResponse.json({ error: "Quoted text not found in document" }, { status: 422 });
    }
    timer({ status: "error" });
    log.error("Agent bridge failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export { postHandler as POST };
