export const REPOSITORY_UPLOAD_STATE_TAG_KEY = "aistudio-upload-state";
export const REPOSITORY_UPLOAD_TEMPORARY_TAG_VALUE = "temporary";
export const REPOSITORY_UPLOAD_PERMANENT_TAG_VALUE = "permanent";
/** Post-signature window before a final sweep may treat an upload as settled. */
export const REPOSITORY_UPLOAD_SETTLE_MS = 60 * 60 * 1000;

/** Exact signed header value required on browser single-part PUT requests. */
export const REPOSITORY_UPLOAD_TEMPORARY_TAGGING =
  `${REPOSITORY_UPLOAD_STATE_TAG_KEY}=${REPOSITORY_UPLOAD_TEMPORARY_TAG_VALUE}`;

export function repositoryUploadTagSet(
  state: "temporary" | "permanent"
): Array<{ Key: string; Value: string }> {
  return [{ Key: REPOSITORY_UPLOAD_STATE_TAG_KEY, Value: state }];
}

export type RepositoryUploadInspectionState =
  | "not_required"
  | "awaiting"
  | "clean"
  | "blocked";

/**
 * Build a complete replacement tag set only after security inspection permits
 * source reads. S3 PutObjectTagging replaces (rather than patches) all tags, so
 * this must preserve GuardDutyMalwareScanStatus and every unrelated tag.
 */
export function permanentRepositoryUploadTags(
  currentTags: ReadonlyArray<{ Key?: string; Value?: string }>,
  inspectionState: RepositoryUploadInspectionState
): Array<{ Key: string; Value: string }> | null {
  if (inspectionState !== "clean" && inspectionState !== "not_required") {
    return null;
  }
  const guardDutyStatus = currentTags.find(
    (tag) => tag.Key === "GuardDutyMalwareScanStatus"
  )?.Value;
  // Defense in depth against a future caller passing `not_required` after a
  // verdict exists. Clean is GuardDuty's only terminal allow value; every
  // other present value remains blocked regardless of rollout configuration.
  if (
    guardDutyStatus !== undefined &&
    guardDutyStatus !== "NO_THREATS_FOUND"
  ) {
    return null;
  }
  if (
    inspectionState === "clean" &&
    guardDutyStatus !== "NO_THREATS_FOUND"
  ) {
    return null;
  }
  const tags = new Map<string, string>();
  for (const tag of currentTags) {
    if (tag.Key && tag.Value !== undefined) tags.set(tag.Key, tag.Value);
  }
  tags.set(
    REPOSITORY_UPLOAD_STATE_TAG_KEY,
    REPOSITORY_UPLOAD_PERMANENT_TAG_VALUE
  );
  return Array.from(tags, ([Key, Value]) => ({ Key, Value }));
}
