/** @jest-environment node */

import {
  assessLegacyRetirementFinalization,
  LEGACY_RETIREMENT_CONFIRMATION,
  parseLegacyRetirementArguments,
  type LegacyRetirementDatabaseSnapshot,
} from "@/lib/repositories/content-platform/retirement-finalization";

const readySnapshot: LegacyRetirementDatabaseSnapshot = {
  activeRuns: 0,
  dryRuns: 1,
  discovered: 3,
  migrated: 3,
  verified: 3,
  mismatched: 0,
  failed: 0,
  unrecoverable: 0,
  rollbackDrills: 1,
  recoveryWindowEndsAt: new Date("2026-07-20T00:00:00Z"),
  cutoversEnabled: true,
  retirementConfigured: true,
  documentsTablePresent: true,
  documentChunksTablePresent: true,
  documentCount: 1,
  documentChunkCount: 2,
  assistantPdfJobCount: 1,
  priorRetirementEvents: 0,
  inventoryComplete: true,
};

describe("unified content legacy retirement finalization", () => {
  it("is dry-run by default and requires the exact execution confirmation", () => {
    expect(parseLegacyRetirementArguments([])).toEqual({
      execute: false,
      confirmed: false,
    });
    expect(
      parseLegacyRetirementArguments([
        "--execute",
        `--confirmation=${LEGACY_RETIREMENT_CONFIRMATION}`,
      ]),
    ).toEqual({ execute: true, confirmed: true });
  });

  it("blocks retirement on a missing dry run or unresolved migration", () => {
    const assessment = assessLegacyRetirementFinalization(
      {
        ...readySnapshot,
        dryRuns: 0,
        verified: 2,
        failed: 1,
        inventoryComplete: false,
      },
      new Date("2026-07-21T00:00:00Z"),
    );
    expect(assessment.ready).toBe(false);
    expect(assessment.blockers).toEqual(
      expect.arrayContaining([
        "a completed migration dry run has not been recorded",
        "failed migrations remain",
        "not every migrated source is verified",
        "legacy source inventory is not fully verified",
      ]),
    );
  });

  it("passes only after all gates and recognizes an evidenced prior finalization", () => {
    expect(
      assessLegacyRetirementFinalization(
        readySnapshot,
        new Date("2026-07-21T00:00:00Z"),
      ),
    ).toEqual({ ready: true, blockers: [], alreadyFinalized: false });
    expect(
      assessLegacyRetirementFinalization({
        ...readySnapshot,
        documentsTablePresent: false,
        documentChunksTablePresent: false,
        priorRetirementEvents: 1,
      }),
    ).toEqual({ ready: true, blockers: [], alreadyFinalized: true });
  });
});
