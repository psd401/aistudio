import {
  BACKFILL_CONFIRMATION,
  assignTurnWindows,
  isBackfillCandidate,
  mergePlans,
  parseBackfillArguments,
  parseTranscriptRecord,
  planSessionBackfill,
  sessionIdFromTranscriptKey,
  transcriptSessionKey,
  type CandidateRow,
  type TranscriptRecord,
} from "@/lib/agents/usage-backfill"

/**
 * The backfill's risk is not "does it run" — it is "does it attribute the right
 * model calls to the right turn". Up to 8 agent_messages rows share one
 * sessionKey and the transcript is append-only across all of them, so a window
 * bug either double-bills a turn or silently drops usage. These tests pin the
 * attribution rules and the write guard.
 */

const row = (overrides: Partial<CandidateRow> & { id: number; createdAtMs: number }): CandidateRow => ({
  sessionId: "agent-chat-abc",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheWriteInputTokens: 0,
  usageCaptureComplete: null,
  ...overrides,
})

const record = (
  timestampMs: number,
  usage: Partial<TranscriptRecord["usage"]> = {},
  stopReason: string | null = "stop"
): TranscriptRecord => ({
  timestampMs,
  usage: {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
  },
  stopReason,
})

const defineTurnWindowSuite = () => {
  it("opens the first turn at the session start and chains the rest", () => {
    const windows = assignTurnWindows(
      [row({ id: 2, createdAtMs: 3_000 }), row({ id: 1, createdAtMs: 2_000 })],
      1_000
    )
    // Input order must not matter — sorted by created_at.
    expect(windows.map((w) => [w.row.id, w.startMs, w.endMs])).toEqual([
      [1, 1_000, 2_000],
      [2, 2_000, 3_000],
    ])
  })

  it("bills a record on a shared boundary to exactly one turn", () => {
    // Windows are half-open at the start, so the record at t=2000 belongs to
    // turn 1 (which ends there) and NOT to turn 2 (which starts there).
    const rows = [
      row({ id: 1, createdAtMs: 2_000 }),
      row({ id: 2, createdAtMs: 3_000 }),
    ]
    const plan = planSessionBackfill(
      rows,
      [record(2_000, { input: 11 })],
      1_000
    )
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0].id).toBe(1)
    expect(plan.updates[0].after.input).toBe(11)
    expect(plan.unmatchedRowIds).toEqual([2])
    expect(plan.unattributedModelCalls).toBe(0)
  })
}

const definePlanSuite = () => {
  it("never bills one session's history to a single turn", () => {
    // The failure this whole design guards against: three turns in one session,
    // each must get only its own model calls.
    const rows = [
      row({ id: 1, createdAtMs: 2_000 }),
      row({ id: 2, createdAtMs: 4_000 }),
      row({ id: 3, createdAtMs: 6_000 }),
    ]
    const records = [
      record(1_500, { input: 1, cacheRead: 100 }),
      record(3_500, { input: 2, cacheRead: 200 }),
      record(5_500, { input: 3, cacheRead: 300 }),
    ]
    const plan = planSessionBackfill(rows, records, 1_000)
    expect(plan.updates.map((u) => [u.id, u.after.input, u.after.cacheRead])).toEqual([
      [1, 1, 100],
      [2, 2, 200],
      [3, 3, 300],
    ])
    // Reconciliation must balance: nothing double-billed, nothing dropped.
    expect(plan.plannedTotals).toEqual(plan.transcriptTotals)
    expect(plan.unattributedModelCalls).toBe(0)
  })

  it("sums every model call within one turn", () => {
    const plan = planSessionBackfill(
      [row({ id: 1, createdAtMs: 9_000 })],
      [
        record(2_000, { input: 1, output: 10 }, "toolUse"),
        record(3_000, { input: 2, output: 20 }, "toolUse"),
        record(4_000, { input: 3, output: 30 }, "stop"),
      ],
      1_000
    )
    expect(plan.updates[0].after).toMatchObject({
      input: 6,
      output: 60,
      usageCaptureComplete: true,
    })
    expect(plan.updates[0].modelCalls).toBe(3)
  })

  it("reports rows with no transcript coverage instead of writing zeros", () => {
    const plan = planSessionBackfill(
      [row({ id: 42, createdAtMs: 5_000 })],
      [],
      1_000
    )
    expect(plan.updates).toHaveLength(0)
    expect(plan.unmatchedRowIds).toEqual([42])
  })

  it("treats a covered turn whose records carry no usage as unrecoverable", () => {
    // Observed on real dev rows from before ~2026-07-29: the transcript has the
    // model calls but no usage numbers on them. Writing zeros over zeros would
    // report a fixed row while recovering nothing, so it must be reported
    // unrecoverable instead.
    const plan = planSessionBackfill(
      [row({ id: 7, createdAtMs: 5_000 })],
      [record(2_000, {}, "toolUse"), record(3_000, {}, "stop")],
      1_000
    )
    expect(plan.updates).toHaveLength(0)
    expect(plan.unmatchedRowIds).toEqual([7])
    // The records WERE found, so they are not "unattributed" either.
    expect(plan.unattributedModelCalls).toBe(0)
  })

  it("counts model calls outside every window as unattributed, not nearest-turn", () => {
    // A record after the last row's created_at cannot belong to any known turn.
    // Forcing it into the closest one would invent cost; it must surface as a
    // reconciliation shortfall instead.
    const plan = planSessionBackfill(
      [row({ id: 1, createdAtMs: 3_000 })],
      [record(2_000, { input: 5 }), record(9_999, { input: 777 })],
      1_000
    )
    expect(plan.updates[0].after.input).toBe(5)
    expect(plan.unattributedModelCalls).toBe(1)
    expect(plan.transcriptTotals.input).toBe(782)
    expect(plan.plannedTotals.input).toBe(5)
  })

  it("lets the LAST in-window record decide completeness", () => {
    // A terminal reason followed by more model calls (a nudge leg) must not
    // latch complete — same rule as the live adapter.
    const plan = planSessionBackfill(
      [row({ id: 1, createdAtMs: 9_000 })],
      [record(2_000, { input: 1 }, "stop"), record(3_000, { input: 1 }, "toolUse")],
      1_000
    )
    expect(plan.updates[0].after.usageCaptureComplete).toBe(false)
  })

  it("treats only allowlisted stop reasons as terminal", () => {
    for (const [stopReason, expected] of [
      ["stop", true],
      ["end_turn", true],
      ["toolUse", false],
      ["error", false],
      ["novel-terminal", false],
      [null, false],
    ] as Array<[string | null, boolean]>) {
      const plan = planSessionBackfill(
        [row({ id: 1, createdAtMs: 9_000 })],
        [record(2_000, { input: 1 }, stopReason)],
        1_000
      )
      expect(plan.updates[0].after.usageCaptureComplete).toBe(expected)
    }
  })
}

const defineRecordParsingSuite = () => {
  it("parses the real transcript record shape", () => {
    const parsed = parseTranscriptRecord({
      id: "e1",
      type: "message",
      timestamp: "2026-08-10T04:08:47.346Z",
      message: {
        role: "assistant",
        timestamp: 1786334925287,
        stopReason: "stop",
        usage: { input: 2, output: 28, cacheRead: 65301, cacheWrite: 995 },
      },
    })
    expect(parsed).toEqual({
      timestampMs: 1786334925287,
      usage: { input: 2, output: 28, cacheRead: 65301, cacheWrite: 995 },
      stopReason: "stop",
    })
  })

  it("falls back to the top-level ISO timestamp", () => {
    const parsed = parseTranscriptRecord({
      timestamp: "2026-08-10T04:08:47.346Z",
      message: { role: "assistant", stopReason: "stop", usage: { input: 5 } },
    })
    expect(parsed?.timestampMs).toBe(Date.parse("2026-08-10T04:08:47.346Z"))
  })

  it("rejects records that carry no usable timestamp", () => {
    expect(
      parseTranscriptRecord({
        message: { role: "assistant", usage: { input: 5 } },
      })
    ).toBeNull()
  })

  it("ignores non-assistant, usageless, and non-object records", () => {
    for (const raw of [
      null,
      "a string",
      [1, 2, 3],
      { message: { role: "user", timestamp: 1, usage: { input: 5 } } },
      { message: { role: "assistant", timestamp: 1 } },
      { type: "session", timestamp: "2026-08-10T04:08:47.346Z" },
    ]) {
      expect(parseTranscriptRecord(raw)).toBeNull()
    }
  })

  it("drops negative, non-numeric, and boolean token values", () => {
    // bool is not a number in TS, but transcript JSON is model-written and a
    // stray `true` must never be counted as a token.
    const parsed = parseTranscriptRecord({
      message: {
        role: "assistant",
        timestamp: 1,
        stopReason: "stop",
        usage: {
          input: 10,
          output: -5,
          cacheRead: "lots",
          cacheWrite: true,
        },
      },
    })
    expect(parsed?.usage).toEqual({
      input: 10,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })
}

const defineGuardSuite = () => {
  it("only treats an all-zero row as a candidate", () => {
    expect(isBackfillCandidate(row({ id: 1, createdAtMs: 0 }))).toBe(true)
    for (const field of [
      "inputTokens",
      "outputTokens",
      "cacheReadInputTokens",
      "cacheWriteInputTokens",
    ] as const) {
      expect(
        isBackfillCandidate(row({ id: 1, createdAtMs: 0, [field]: 1 }))
      ).toBe(false)
    }
  })

  it("round-trips the transcript session key", () => {
    const sessionId = "agent-chat-646172ab014f27d5"
    const key = transcriptSessionKey(sessionId)
    // Verified against a real checkpointed database.
    expect(key).toBe(`agent:main:${sessionId}`)
    expect(sessionIdFromTranscriptKey(key)).toBe(sessionId)
  })

  it("returns null for a session key that is not ours", () => {
    expect(sessionIdFromTranscriptKey("agent:other:xyz")).toBeNull()
    expect(sessionIdFromTranscriptKey("something-else")).toBeNull()
  })
}

const defineArgumentSuite = () => {
  it("defaults to a dry run with no flags", () => {
    const args = parseBackfillArguments([])
    expect(args.execute).toBe(false)
    expect(args.confirmed).toBe(false)
  })

  it("requires the exact confirmation token", () => {
    expect(parseBackfillArguments(["--execute"]).confirmed).toBe(false)
    expect(
      parseBackfillArguments(["--execute", "--confirmation=nope"]).confirmed
    ).toBe(false)
    const good = parseBackfillArguments([
      "--execute",
      `--confirmation=${BACKFILL_CONFIRMATION}`,
    ])
    expect(good.execute && good.confirmed).toBe(true)
  })

  it("parses the prefix and since filters", () => {
    const args = parseBackfillArguments([
      "--prefix=hagelk-db0f32b5",
      "--since=2026-07-30T00:00:00Z",
    ])
    expect(args.prefix).toBe("hagelk-db0f32b5")
    expect(args.sinceMs).toBe(Date.parse("2026-07-30T00:00:00Z"))
  })

  it("degrades an unparseable since to no filter rather than to epoch 0", () => {
    // Silently becoming 0 would widen the scan to all history.
    expect(parseBackfillArguments(["--since=not-a-date"]).sinceMs).toBeNull()
  })
}

const defineMergeSuite = () => {
  it("sums totals across sessions", () => {
    const a = planSessionBackfill(
      [row({ id: 1, createdAtMs: 3_000 })],
      [record(2_000, { input: 5, cacheRead: 50 })],
      1_000
    )
    const b = planSessionBackfill(
      [row({ id: 2, createdAtMs: 3_000, sessionId: "agent-chat-two" })],
      [record(2_000, { input: 7, cacheRead: 70 })],
      1_000
    )
    const merged = mergePlans([a, b])
    expect(merged.updates.map((u) => u.id)).toEqual([1, 2])
    expect(merged.plannedTotals).toMatchObject({ input: 12, cacheRead: 120 })
  })
}

describe("agent usage backfill — turn windows", defineTurnWindowSuite)
describe("agent usage backfill — plan", definePlanSuite)
describe("agent usage backfill — record parsing", defineRecordParsingSuite)
describe("agent usage backfill — write guard", defineGuardSuite)
describe("agent usage backfill — arguments", defineArgumentSuite)
describe("agent usage backfill — merge", defineMergeSuite)
