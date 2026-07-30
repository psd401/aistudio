import {
  TRIAGE_LABEL_MAPPING_PROVENANCE,
  TRIAGE_LABEL_MAPPING_VERSION,
  TRIAGE_LABEL_NAMES,
  type TrustedTriageLabelMapping,
} from "../label-mapping";
import { loadTrustedLabelMappingForRow } from "../trusted-label-mapping";
import type { GmailLabel } from "../gmail";
import type { TriageRow } from "../types";

const OWNER = "owner@example.com";
const IDS = {
  important: "Label_important",
  later: "Label_later",
  news: "Label_news",
  task: "Label_task",
};

function liveLabels(): GmailLabel[] {
  return Object.entries(TRIAGE_LABEL_NAMES).map(([key, name]) => ({
    id: IDS[key as keyof typeof IDS],
    name,
    type: "user",
  }));
}

function row(overrides: Partial<TriageRow> = {}): TriageRow {
  return {
    userEmail: OWNER,
    enabled: true,
    labels: TRIAGE_LABEL_NAMES,
    labelIdsByKey: IDS,
    labelMappingVersion: TRIAGE_LABEL_MAPPING_VERSION,
    labelMappingProvenance: TRIAGE_LABEL_MAPPING_PROVENANCE,
    labelMappingOwnerEmail: OWNER,
    labelMappingResolvedAt: "2026-07-26T00:00:00.000Z",
    rules: { vipSenders: [], muteSenders: [], keywordRules: [] },
    escalation: { senders: [], keywords: [], labelTriggers: [] },
    digestEnabled: false,
    recentDecisions: [],
    recentCorrections: [],
    ...overrides,
  };
}

function dependencies(labels: GmailLabel[] = liveLabels()) {
  return {
    loadLiveLabels: jest.fn().mockResolvedValue(labels),
    stampTrustedMapping: jest
      .fn<Promise<void>, [TrustedTriageLabelMapping]>()
      .mockResolvedValue(undefined),
    log: jest.fn(),
  };
}

describe("trusted triage label mapping orchestration", () => {
  it("stamps a legacy row and returns the healed mapping for same-tick work", async () => {
    const deps = dependencies();
    const result = await loadTrustedLabelMappingForRow(
      row({
        labelMappingVersion: undefined,
        labelMappingProvenance: undefined,
        labelMappingOwnerEmail: undefined,
        labelMappingResolvedAt: undefined,
      }),
      deps,
    );

    expect(result).toEqual(
      expect.objectContaining({
        labels: TRIAGE_LABEL_NAMES,
        labelIdsByKey: IDS,
        labelMappingVersion: TRIAGE_LABEL_MAPPING_VERSION,
        labelMappingProvenance: TRIAGE_LABEL_MAPPING_PROVENANCE,
        labelMappingOwnerEmail: OWNER,
      }),
    );
    expect(deps.stampTrustedMapping).toHaveBeenCalledWith(result);
    expect(deps.log).toHaveBeenCalledWith(
      "INFO",
      "label_mapping_healed",
      expect.objectContaining({ user: OWNER }),
    );
  });

  it("fails closed without a stamp when canonical live labels are ambiguous", async () => {
    const deps = dependencies([
      ...liveLabels(),
      {
        id: "Label_important_duplicate",
        name: TRIAGE_LABEL_NAMES.important,
        type: "user",
      },
    ]);

    await expect(
      loadTrustedLabelMappingForRow(
        row({ labelMappingVersion: undefined }),
        deps,
      ),
    ).resolves.toBeNull();
    expect(deps.stampTrustedMapping).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(
      "ERROR",
      "untrusted_label_mapping",
      {
        user: OWNER,
        reason: "missing-or-ambiguous-live-label",
      },
    );
  });

  it("fails closed and logs when trusted provenance has no label id map", async () => {
    const deps = dependencies();

    await expect(
      loadTrustedLabelMappingForRow(
        row({ labelIdsByKey: undefined }),
        deps,
      ),
    ).resolves.toBeNull();
    expect(deps.loadLiveLabels).not.toHaveBeenCalled();
    expect(deps.stampTrustedMapping).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(
      "ERROR",
      "untrusted_label_mapping",
      {
        user: OWNER,
        reason: "invalid-or-system-label",
      },
    );
  });

  it("passes a valid row through without a re-resolution write", async () => {
    const deps = dependencies();

    await expect(
      loadTrustedLabelMappingForRow(row(), deps),
    ).resolves.toEqual(
      expect.objectContaining({
        labelIdsByKey: IDS,
        labelMappingOwnerEmail: OWNER,
      }),
    );
    expect(deps.loadLiveLabels).toHaveBeenCalledTimes(1);
    expect(deps.stampTrustedMapping).not.toHaveBeenCalled();
  });
});
