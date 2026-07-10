/**
 * Agent turn trace export (issue #1161) — the analysis half of Loop 2.
 *
 * Given a session id, prints the call-by-call trace of every turn in that
 * session: per-turn model-call count, wall-clock duration, token split, and the
 * ordered tool invocations (agent_tool_invocations) with their timings and
 * status. This is the input for playbook rounds — export the trace of a slow
 * turn, see where the iterations go (which tools loop, how long each takes),
 * rewrite the layer-3 playbook instructions, then re-measure via the dashboard
 * aggregates.
 *
 * The #1138 finding — a 47-model-call, 14.5-minute turn for a check-and-report
 * task — was discovered by hand-reading logs. This makes that a one-liner.
 *
 * Run:
 *   bunx tsx scripts/agent-trace-export.ts <session-id>            (needs DATABASE_URL)
 *   bunx tsx scripts/agent-trace-export.ts <session-id> --json     (machine-readable)
 *
 * Tip: the shared DB client logs a per-query line at debug level. To get just
 * the trace, run with NODE_ENV=test (drops the logger to error level), e.g.
 *   NODE_ENV=test bunx tsx scripts/agent-trace-export.ts <session-id>
 *
 * Per-model-call detail (each individual Mantle round-trip) is NOT persisted —
 * only the per-turn count (agent_messages.model_call_count) is. For finer
 * granularity grep the AgentCore CloudWatch log for the session id: the wrapper
 * logs one "Invocation complete: ... model_calls=N duration_ms=M" line per turn
 * and mantle_proxy logs each upstream request/response.
 */

import { asc, eq } from "drizzle-orm";
import { executeQuery } from "@/lib/db/drizzle-client";
import { agentMessages } from "@/lib/db/schema/tables/agent-messages";
import { agentToolInvocations } from "@/lib/db/schema/tables/agent-tool-invocations";
import { scriptLogger as log } from "./db/script-logger";

interface ToolCall {
  toolName: string;
  status: string;
  durationMs: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorText: string | null;
  toolArgs: Record<string, unknown> | null;
}

interface TurnTrace {
  messageId: number;
  createdAt: Date | null;
  model: string | null;
  modelCallCount: number;
  durationMs: number;
  latencyMs: number;
  nudged: boolean;
  guardrailBlocked: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  toolCalls: ToolCall[];
}

function out(line = ""): void {
  process.stdout.write(line + "\n");
}

/** Compact a possibly-large args object into a short single-line preview. */
function previewArgs(args: Record<string, unknown> | null): string {
  if (!args) return "";
  try {
    const s = JSON.stringify(args);
    return s.length > 120 ? s.slice(0, 117) + "..." : s;
  } catch {
    return "<unserializable>";
  }
}

function fmtMs(ms: number): string {
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

async function loadTrace(sessionId: string): Promise<TurnTrace[]> {
  const messages = await executeQuery(
    (db) =>
      db
        .select()
        .from(agentMessages)
        .where(eq(agentMessages.sessionId, sessionId))
        .orderBy(asc(agentMessages.createdAt)),
    "traceExport.messages"
  );

  const turns: TurnTrace[] = [];
  for (const m of messages) {
    const tools = await executeQuery(
      (db) =>
        db
          .select()
          .from(agentToolInvocations)
          .where(eq(agentToolInvocations.messageId, m.id))
          .orderBy(asc(agentToolInvocations.startedAt)),
      "traceExport.tools"
    );
    turns.push({
      messageId: m.id,
      createdAt: m.createdAt,
      model: m.model,
      modelCallCount: m.modelCallCount,
      durationMs: m.durationMs,
      latencyMs: m.latencyMs,
      nudged: m.nudged,
      guardrailBlocked: m.guardrailBlocked,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cacheReadInputTokens: m.cacheReadInputTokens,
      cacheWriteInputTokens: m.cacheWriteInputTokens,
      toolCalls: tools.map((t) => ({
        toolName: t.toolName,
        status: t.status,
        durationMs: t.durationMs,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
        errorText: t.errorText,
        toolArgs: t.toolArgs,
      })),
    });
  }
  return turns;
}

function printHuman(sessionId: string, turns: TurnTrace[]): void {
  out(`=== Agent trace: session ${sessionId} ===`);
  out(`${turns.length} turn(s)`);
  out("");

  let totalModelCalls = 0;
  let totalToolCalls = 0;
  let totalDurationMs = 0;
  let totalTokens = 0;

  for (const [i, turn] of turns.entries()) {
    totalModelCalls += turn.modelCallCount;
    totalToolCalls += turn.toolCalls.length;
    totalDurationMs += turn.durationMs;
    totalTokens +=
      turn.inputTokens +
      turn.outputTokens +
      turn.cacheReadInputTokens +
      turn.cacheWriteInputTokens;

    const ts = turn.createdAt ? turn.createdAt.toISOString() : "?";
    out(`TURN ${i + 1}  [${ts}]  message_id=${turn.messageId}`);
    out(
      `  model=${turn.model ?? "?"}  model_calls=${turn.modelCallCount}  ` +
        `duration=${fmtMs(turn.durationMs)}  latency=${fmtMs(turn.latencyMs)}  ` +
        `nudged=${turn.nudged}  guardrail=${turn.guardrailBlocked}`
    );
    out(
      `  tokens: in=${turn.inputTokens} out=${turn.outputTokens} ` +
        `cache_read=${turn.cacheReadInputTokens} cache_write=${turn.cacheWriteInputTokens}`
    );

    if (turn.toolCalls.length === 0) {
      out("  (no tool invocations recorded)");
    } else {
      out(`  tool invocations (${turn.toolCalls.length}):`);
      const turnStart = turn.createdAt?.getTime();
      for (const [j, tc] of turn.toolCalls.entries()) {
        const startMs = tc.startedAt?.getTime();
        const offset =
          turnStart != null && startMs != null
            ? `+${((startMs - turnStart) / 1000).toFixed(1)}s`
            : "?";
        const err = tc.errorText ? `  ERROR: ${tc.errorText.slice(0, 80)}` : "";
        out(
          `    [${j + 1}] ${offset.padStart(7)}  ${tc.toolName.padEnd(24)} ` +
            `${tc.status.padEnd(8)} ${fmtMs(tc.durationMs).padStart(7)}  ` +
            `${previewArgs(tc.toolArgs)}${err}`
        );
      }
    }
    out("");
  }

  out("=== summary ===");
  out(`  turns:        ${turns.length}`);
  out(`  model calls:  ${totalModelCalls}`);
  out(`  tool calls:   ${totalToolCalls}`);
  out(`  duration:     ${fmtMs(totalDurationMs)}`);
  out(`  total tokens: ${totalTokens}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const sessionId = args.find((a) => !a.startsWith("--"));

  if (!sessionId) {
    log.error(
      "Usage: bunx tsx scripts/agent-trace-export.ts <session-id> [--json]"
    );
    process.exit(1);
  }

  const turns = await loadTrace(sessionId);

  if (turns.length === 0) {
    log.warn(`No turns found for session ${sessionId}`);
    process.exit(0);
  }

  if (jsonMode) {
    out(JSON.stringify({ sessionId, turns }, null, 2));
  } else {
    printHuman(sessionId, turns);
  }
}

main().catch((error) => {
  log.error("Trace export failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
