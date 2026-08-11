import {
  BACKFILL_CONFIRMATION,
  isBackfillCandidate,
  mergePlans,
  parseBackfillArguments,
  parseTranscriptRecord,
  planSessionBackfill,
  restrictPlanToRowsSince,
  segmentTurns,
  sessionIdFromTranscriptKey,
  transcriptSessionKey,
  type CandidateRow,
  type TranscriptRecord,
} from "@/lib/agents/usage-backfill"

/**
 * The backfill's risk is not "does it run" — it is "does it attribute the right
 * model calls to the right turn". Up to 8 agent_messages rows share one
 * sessionKey and the transcript is append-only across all of them, so an
 * attribution bug either double-bills a turn or silently drops usage, and does
 * it while reporting success.
 *
 * Row timestamps CANNOT bound a turn: the router releases the session lock
 * before it inserts the telemetry row, so the next turn can write transcript
 * records before the previous row is stamped. These tests pin the replacement —
 * segment the transcript by its own terminal stopReasons, pair segment k with
 * row k, and refuse to attribute anything when the counts disagree.
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

const defineSegmentSuite = () => {
  it("cuts one segment per terminal stop reason", () => {
    const segments = segmentTurns([
      record(1_000, { input: 1 }, "toolUse"),
      record(2_000, { input: 2 }, "stop"),
      record(3_000, { input: 3 }, "end_turn"),
    ])
    expect(segments.map((s) => s.map((r) => r.timestampMs))).toEqual([
      [1_000, 2_000],
      [3_000],
    ])
  })

  it("drops a trailing run with no terminal reason", () => {
    // An in-flight or aborted turn has no agent_messages row to receive it.
    // Returning it would shift the pairing and misprice every turn after it.
    const segments = segmentTurns([
      record(1_000, { input: 1 }, "stop"),
      record(2_000, { input: 2 }, "toolUse"),
    ])
    expect(segments).toHaveLength(1)
    expect(segments[0].map((r) => r.timestampMs)).toEqual([1_000])
  })

  it("never treats a novel or absent reason as terminal", () => {
    for (const stopReason of ["toolUse", "error", "novel-terminal", null]) {
      expect(segmentTurns([record(1_000, { input: 1 }, stopReason)])).toEqual([])
    }
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
    const plan = planSessionBackfill(rows, records)
    expect(plan.updates.map((u) => [u.id, u.after.input, u.after.cacheRead])).toEqual([
      [1, 1, 100],
      [2, 2, 200],
      [3, 3, 300],
    ])
    // Reconciliation must balance: nothing double-billed, nothing dropped.
    expect(plan.plannedTotals).toEqual(plan.transcriptTotals)
    expect(plan.unattributedModelCalls).toBe(0)
    expect(plan.turnCountMismatches).toBe(0)
  })

  it("sums every model call within one turn", () => {
    const plan = planSessionBackfill(
      [row({ id: 1, createdAtMs: 9_000 })],
      [
        record(2_000, { input: 1, output: 10 }, "toolUse"),
        record(3_000, { input: 2, output: 20 }, "toolUse"),
        record(4_000, { input: 3, output: 30 }, "stop"),
      ]
    )
    expect(plan.updates[0].after).toMatchObject({
      input: 6,
      output: 60,
      // Every paired segment ends on a terminal reason by construction.
      usageCaptureComplete: true,
    })
    expect(plan.updates[0].modelCalls).toBe(3)
    expect(plan.updates[0].turnIndex).toBe(0)
  })

  it("lets an already-populated row consume its segment without touching it", () => {
    // The pairing needs EVERY row, not just the zero ones. Filtering populated
    // rows out beforehand would slide turn 2's segment onto turn 2's row while
    // it actually belongs to turn 1 — a silently mispriced turn.
    const plan = planSessionBackfill(
      [
        row({ id: 1, createdAtMs: 2_000, inputTokens: 500, outputTokens: 5 }),
        row({ id: 2, createdAtMs: 4_000 }),
      ],
      [
        record(1_500, { input: 111 }),
        record(3_500, { input: 222 }),
      ]
    )
    expect(plan.updates).toHaveLength(1)
    expect(plan.updates[0].id).toBe(2)
    // The SECOND segment, not the first.
    expect(plan.updates[0].after.input).toBe(222)
    expect(plan.updates[0].turnIndex).toBe(1)
    expect(plan.unmatchedRowIds).toEqual([])
    expect(plan.unattributedModelCalls).toBe(0)
  })

  it("refuses to attribute anything when turn and row counts disagree", () => {
    // A count mismatch means our model of the session is wrong. Pairing the
    // wrong segment with the wrong row would write confidently wrong costs, so
    // the run reports the gap instead.
    const plan = planSessionBackfill(
      [row({ id: 1, createdAtMs: 2_000 }), row({ id: 2, createdAtMs: 4_000 })],
      [record(1_500, { input: 5 })]
    )
    expect(plan.updates).toEqual([])
    expect(plan.turnCountMismatches).toBe(1)
    expect(plan.unmatchedRowIds).toEqual([1, 2])
    expect(plan.unattributedModelCalls).toBe(1)
    expect(plan.plannedTotals.input).toBe(0)
    // The transcript total is still reported, so the shortfall is visible.
    expect(plan.transcriptTotals.input).toBe(5)
  })

  it("reports a row with no transcript coverage instead of writing zeros", () => {
    const plan = planSessionBackfill([row({ id: 42, createdAtMs: 5_000 })], [])
    expect(plan.updates).toHaveLength(0)
    expect(plan.unmatchedRowIds).toEqual([42])
    expect(plan.turnCountMismatches).toBe(1)
  })

  it("treats a covered turn whose records carry no usage as unrecoverable", () => {
    // Observed on real dev rows from before ~2026-07-29: the transcript has the
    // model calls but no usage numbers on them. Writing zeros over zeros would
    // report a fixed row while recovering nothing.
    const plan = planSessionBackfill(
      [row({ id: 7, createdAtMs: 5_000 })],
      [record(2_000, {}, "toolUse"), record(3_000, {}, "stop")]
    )
    expect(plan.updates).toHaveLength(0)
    expect(plan.unmatchedRowIds).toEqual([7])
    // The records WERE found and paired, so they are not "unattributed".
    expect(plan.unattributedModelCalls).toBe(0)
  })

  it("counts a trailing in-flight turn's calls as unattributed", () => {
    // Records after the last completed turn cannot belong to any existing row.
    // They must surface as a reconciliation shortfall, never be folded into the
    // nearest turn.
    const plan = planSessionBackfill(
      [row({ id: 1, createdAtMs: 3_000 })],
      [record(2_000, { input: 5 }), record(9_999, { input: 777 }, "toolUse")]
    )
    expect(plan.updates[0].after.input).toBe(5)
    expect(plan.unattributedModelCalls).toBe(1)
    expect(plan.transcriptTotals.input).toBe(782)
    expect(plan.plannedTotals.input).toBe(5)
  })
}

const defineRestrictSuite = () => {
  it("drops updates for rows older than the cutoff and recomputes totals", () => {
    // --since selects which rows may be WRITTEN. It must never remove rows
    // before pairing, or it would delete the anchors that establish turn order.
    const plan = planSessionBackfill(
      [row({ id: 1, createdAtMs: 2_000 }), row({ id: 2, createdAtMs: 6_000 })],
      [record(1_500, { input: 5 }), record(5_500, { input: 70 })]
    )
    const restricted = restrictPlanToRowsSince(plan, 5_000)
    expect(restricted.updates.map((u) => u.id)).toEqual([2])
    expect(restricted.plannedTotals.input).toBe(70)
    // The transcript total is untouched — the shortfall stays visible.
    expect(restricted.transcriptTotals.input).toBe(75)
  })

  it("passes the plan through unchanged with no cutoff", () => {
    const plan = planSessionBackfill(
      [row({ id: 1, createdAtMs: 2_000 })],
      [record(1_500, { input: 5 })]
    )
    expect(restrictPlanToRowsSince(plan, null)).toBe(plan)
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
    expect(args.errors).toEqual([])
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
    expect(good.errors).toEqual([])
  })

  it("parses the prefix and since filters", () => {
    const args = parseBackfillArguments([
      "--prefix=hagelk-db0f32b5",
      "--since=2026-07-30T00:00:00Z",
    ])
    expect(args.prefix).toBe("hagelk-db0f32b5")
    expect(args.sinceMs).toBe(Date.parse("2026-07-30T00:00:00Z"))
    expect(args.errors).toEqual([])
  })

  it("errors on an unparseable since rather than silently dropping the filter", () => {
    // Degrading to "no filter" would widen a production run from the outage
    // window to ALL history — the opposite of what a mistyped date asked for.
    const args = parseBackfillArguments(["--since=not-a-date"])
    expect(args.sinceMs).toBeNull()
    expect(args.errors).toHaveLength(1)
  })

  it("errors on an empty prefix and on any unrecognized argument", () => {
    expect(parseBackfillArguments(["--prefix="]).errors).toHaveLength(1)
    expect(parseBackfillArguments(["--dry-run"]).errors).toHaveLength(1)
  })
}

const defineMergeSuite = () => {
  it("sums totals and mismatch counts across sessions", () => {
    const a = planSessionBackfill(
      [row({ id: 1, createdAtMs: 3_000 })],
      [record(2_000, { input: 5, cacheRead: 50 })]
    )
    const b = planSessionBackfill(
      [row({ id: 2, createdAtMs: 3_000, sessionId: "agent-chat-two" })],
      [record(2_000, { input: 7, cacheRead: 70 })]
    )
    // A session we refused to attribute must still be counted in the merge.
    const c = planSessionBackfill(
      [row({ id: 3, createdAtMs: 3_000, sessionId: "agent-chat-three" })],
      []
    )
    const merged = mergePlans([a, b, c])
    expect(merged.updates.map((u) => u.id)).toEqual([1, 2])
    expect(merged.plannedTotals).toMatchObject({ input: 12, cacheRead: 120 })
    expect(merged.turnCountMismatches).toBe(1)
    expect(merged.unmatchedRowIds).toEqual([3])
  })
}

describe("agent usage backfill — turn segmentation", defineSegmentSuite)
describe("agent usage backfill — plan", definePlanSuite)
describe("agent usage backfill — since filter", defineRestrictSuite)
describe("agent usage backfill — record parsing", defineRecordParsingSuite)
describe("agent usage backfill — write guard", defineGuardSuite)
describe("agent usage backfill — arguments", defineArgumentSuite)
describe("agent usage backfill — merge", defineMergeSuite)
