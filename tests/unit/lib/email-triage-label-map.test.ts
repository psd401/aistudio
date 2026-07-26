import fs from "node:fs"
import path from "node:path"
import {
  createTrustedEmailTriageLabelMapping,
  EMAIL_TRIAGE_LABELS,
  validateTrustedEmailTriageLabelMapping,
} from "@/lib/agent/email-triage-label-map"
const {
  resolveTrustedTriageLabelMapping,
  TRIAGE_LABEL_MAPPING_PROVENANCE,
  TRIAGE_LABEL_MAPPING_VERSION,
  TRIAGE_LABEL_NAMES,
} = jest.requireActual<{
  resolveTrustedTriageLabelMapping: (
    row: {
      userEmail: string
      labels: Record<keyof typeof IDS, string>
      labelIdsByKey: Record<keyof typeof IDS, string>
      labelMappingVersion?: number
      labelMappingProvenance?: string
      labelMappingOwnerEmail?: string
      labelMappingResolvedAt?: string
      [key: string]: unknown
    },
    loadLiveLabels: () => Promise<
      Array<{ id: string; name: string; type: "user" }>
    >
  ) => Promise<Record<keyof typeof IDS, string> | null>
  TRIAGE_LABEL_MAPPING_PROVENANCE: string
  TRIAGE_LABEL_MAPPING_VERSION: number
  TRIAGE_LABEL_NAMES: Record<keyof typeof IDS, string>
}>("@/infra/lambdas/agent-triage-poll/label-mapping")

const IDS = {
  important: "Label_important",
  later: "Label_later",
  news: "Label_news",
  task: "Label_task",
}

function trustedState() {
  return {
    userEmail: "owner@example.com",
    ...createTrustedEmailTriageLabelMapping({
      ownerEmail: "owner@example.com",
      labelIdsByKey: IDS,
      resolvedAt: "2026-07-26T00:00:00.000Z",
    }),
  }
}

function liveLabels(): Array<{ id: string; name: string; type: "user" }> {
  return Object.entries(EMAIL_TRIAGE_LABELS).map(([key, name]) => ({
    id: IDS[key as keyof typeof IDS],
    name,
    type: "user",
  }))
}

describe("trusted email triage label mapping", () => {
  it("accepts the owner-bound versioned mapping only when Gmail agrees", () => {
    expect(
      validateTrustedEmailTriageLabelMapping(trustedState(), liveLabels())
    ).toEqual({ valid: true, labelIdsByKey: IDS })
  })

  it.each([
    [{ labelMappingVersion: 0 }, "untrusted-or-stale-provenance"],
    [{ labelMappingOwnerEmail: "other@example.com" }, "untrusted-or-stale-provenance"],
    [{ labelIdsByKey: { ...IDS, important: "INBOX" } }, "invalid-or-system-label"],
  ])("rejects stale, foreign, or system mappings", (override, reason) => {
    expect(
      validateTrustedEmailTriageLabelMapping(
        { ...trustedState(), ...override },
        liveLabels()
      )
    ).toEqual({ valid: false, reason })
  })

  it("rejects an ID that now belongs to an unrelated live label", () => {
    const labels = liveLabels()
    labels[0] = { ...labels[0], name: "Unrelated" }
    expect(
      validateTrustedEmailTriageLabelMapping(trustedState(), labels)
    ).toEqual({
      valid: false,
      reason: "missing-or-unrelated-live-label",
    })
  })

  it("keeps model-controlled state updates away from label mappings", () => {
    const route = fs.readFileSync(
      path.join(process.cwd(), "app/api/agent/email-triage/route.ts"),
      "utf8"
    )
    const safeFields = route.slice(
      route.indexOf("const SAFE_STATE_FIELDS"),
      route.indexOf("function tableName")
    )
    expect(safeFields).not.toContain('"labelIdsByKey"')
    expect(safeFields).not.toContain('"labels"')
    expect(route).toContain('body.operation === "ensure-labels"')
  })

  it("does not call Gmail for a malformed legacy mapping", async () => {
    const loadLiveLabels = jest.fn().mockResolvedValue(liveLabels())
    await expect(
      resolveTrustedTriageLabelMapping(
        {
          userEmail: "owner@example.com",
          enabled: true,
          labels: EMAIL_TRIAGE_LABELS,
          labelIdsByKey: IDS,
          rules: { vipSenders: [], muteSenders: [], keywordRules: [] },
          escalation: { senders: [], keywords: [], labelTriggers: [] },
          digestEnabled: false,
          recentDecisions: [],
          recentCorrections: [],
        },
        loadLiveLabels
      )
    ).resolves.toBeNull()
    expect(loadLiveLabels).not.toHaveBeenCalled()
  })

  it("keeps the route and standalone worker trust contracts aligned", () => {
    expect(TRIAGE_LABEL_MAPPING_VERSION).toBe(
      trustedState().labelMappingVersion
    )
    expect(TRIAGE_LABEL_MAPPING_PROVENANCE).toBe(
      trustedState().labelMappingProvenance
    )
    expect(TRIAGE_LABEL_NAMES).toEqual(EMAIL_TRIAGE_LABELS)
  })

  it("validates before mutation while preserving trusted archive behavior", () => {
    const worker = fs.readFileSync(
      path.join(
        process.cwd(),
        "infra/lambdas/agent-triage-poll/index.ts"
      ),
      "utf8"
    )
    const classifier = worker.slice(
      worker.indexOf("export async function classifyAndLabel("),
      worker.indexOf("async function buildFeatures(")
    )
    expect(classifier.indexOf("trustedLabelIdsForRow(")).toBeLessThan(
      classifier.indexOf("getMessageMetadata(")
    )
    expect(classifier.indexOf("if (!trustedLabelIds) return null")).toBeLessThan(
      classifier.indexOf("modifyMessage(")
    )
    expect(classifier).toContain(
      'modifyMessage(accessToken, msgRef.id, [labelId], ["INBOX"])'
    )
  })
})
