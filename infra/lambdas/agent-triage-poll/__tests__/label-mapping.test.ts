import {
  resolveCanonicalTriageLabelMapping,
  TRIAGE_LABEL_MAPPING_PROVENANCE,
  TRIAGE_LABEL_MAPPING_VERSION,
  TRIAGE_LABEL_NAMES,
} from "../label-mapping";
import type { GmailLabel } from "../gmail";

const OWNER = "owner@example.com";
const IDS = {
  important: "Label_important",
  later: "Label_later",
  news: "Label_news",
  task: "Label_task",
};

function liveLabels(
  ids: typeof IDS = IDS,
): GmailLabel[] {
  return Object.entries(TRIAGE_LABEL_NAMES).map(([key, name]) => ({
    id: ids[key as keyof typeof IDS],
    name,
    type: "user",
  }));
}

describe("triage label mapping self-heal resolution", () => {
  it("rebuilds every trusted field from canonical live owner labels", async () => {
    await expect(
      resolveCanonicalTriageLabelMapping(
        OWNER,
        async () => liveLabels(),
        "2026-07-30T12:00:00.000Z",
      ),
    ).resolves.toEqual({
      valid: true,
      mapping: {
        labels: TRIAGE_LABEL_NAMES,
        labelIdsByKey: IDS,
        labelMappingVersion: TRIAGE_LABEL_MAPPING_VERSION,
        labelMappingProvenance: TRIAGE_LABEL_MAPPING_PROVENANCE,
        labelMappingOwnerEmail: OWNER,
        labelMappingResolvedAt: "2026-07-30T12:00:00.000Z",
      },
    });
  });

  it.each([
    [
      "missing",
      liveLabels().filter(
        (label) => label.name !== TRIAGE_LABEL_NAMES.important,
      ),
      "missing-or-ambiguous-live-label",
    ],
    [
      "ambiguous",
      [
        ...liveLabels(),
        {
          id: "Label_important_duplicate",
          name: TRIAGE_LABEL_NAMES.important,
          type: "user" as const,
        },
      ],
      "missing-or-ambiguous-live-label",
    ],
    [
      "system id",
      liveLabels({ ...IDS, important: "INBOX" }),
      "invalid-or-system-label",
    ],
    [
      "duplicate id",
      liveLabels({ ...IDS, later: IDS.important }),
      "duplicate-label-id",
    ],
  ])("fails closed for %s live state", async (_name, labels, reason) => {
    await expect(
      resolveCanonicalTriageLabelMapping(OWNER, async () => labels),
    ).resolves.toEqual({ valid: false, reason });
  });
});
