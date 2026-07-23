/** @jest-environment node */

import {
  permanentRepositoryUploadTags,
  REPOSITORY_UPLOAD_STATE_TAG_KEY,
} from "@/lib/repositories/content-platform/upload-state";
import { decideMalwareInspection } from "@/infra/lambdas/unified-content-processor/contract";

describe("repository upload lifecycle tags", () => {
  it("returns a promotion so a clean job proceeds without erasing GuardDuty or unrelated tags", () => {
    const promoted = permanentRepositoryUploadTags(
        [
          { Key: REPOSITORY_UPLOAD_STATE_TAG_KEY, Value: "temporary" },
          {
            Key: "GuardDutyMalwareScanStatus",
            Value: "NO_THREATS_FOUND",
          },
          { Key: "data-classification", Value: "internal" },
        ],
        decideMalwareInspection(true, "NO_THREATS_FOUND").status
      );
    expect(promoted).not.toBeNull();
    expect(promoted).toEqual(
      expect.arrayContaining([
        { Key: REPOSITORY_UPLOAD_STATE_TAG_KEY, Value: "permanent" },
        {
          Key: "GuardDutyMalwareScanStatus",
          Value: "NO_THREATS_FOUND",
        },
        { Key: "data-classification", Value: "internal" },
      ])
    );
  });

  it.each(["awaiting", "blocked"] as const)(
    "cannot erase or promote a %s inspection",
    (inspectionState) => {
      expect(
        permanentRepositoryUploadTags(
          [
            { Key: REPOSITORY_UPLOAD_STATE_TAG_KEY, Value: "temporary" },
            {
              Key: "GuardDutyMalwareScanStatus",
              Value:
                inspectionState === "blocked"
                  ? "THREATS_FOUND"
                  : "PENDING",
            },
          ],
          inspectionState
        )
      ).toBeNull();
    }
  );

  it("keeps a GuardDuty threat terminal and ineligible for tag promotion", () => {
    const decision = decideMalwareInspection(true, "THREATS_FOUND");
    expect(decision).toEqual({
      status: "blocked",
      providerStatus: "THREATS_FOUND",
    });
    expect(
      permanentRepositoryUploadTags(
        [
          { Key: REPOSITORY_UPLOAD_STATE_TAG_KEY, Value: "temporary" },
          {
            Key: "GuardDutyMalwareScanStatus",
            Value: "THREATS_FOUND",
          },
        ],
        decision.status
      )
    ).toBeNull();
    expect(
      permanentRepositoryUploadTags(
        [
          { Key: REPOSITORY_UPLOAD_STATE_TAG_KEY, Value: "temporary" },
          {
            Key: "GuardDutyMalwareScanStatus",
            Value: "THREATS_FOUND",
          },
        ],
        "not_required"
      )
    ).toBeNull();
  });
});
