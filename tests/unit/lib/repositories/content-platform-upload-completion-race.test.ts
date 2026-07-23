/** @jest-environment node */

import {
  assertRepositoryUploadSessionActive,
} from "@/lib/repositories/content-platform/upload-service";
import type { RepositoryUploadStatus } from "@/lib/db/schema";

const NOW = new Date("2026-07-23T12:00:00.000Z");
const FUTURE = new Date("2026-07-23T12:01:00.000Z");
const PAST = new Date("2026-07-23T11:59:00.000Z");

describe("canonical upload completion lifecycle race", () => {
  it("accepts a still-active row after completion acquires its lock", () => {
    expect(() =>
      assertRepositoryUploadSessionActive(
        { status: "uploading", expiresAt: FUTURE },
        NOW
      )
    ).not.toThrow();
  });

  const inactiveSessions: Array<
    [string, { status: RepositoryUploadStatus; expiresAt: Date }]
  > = [
    [
      "cleanup changed the locked status",
      { status: "expired", expiresAt: FUTURE },
    ],
    [
      "expiry elapsed while waiting for the lock",
      { status: "uploading", expiresAt: PAST },
    ],
    [
      "cleanup already finalized the row",
      { status: "aborted", expiresAt: FUTURE },
    ],
  ];

  it.each(inactiveSessions)("rejects registration when %s", (_caseName, session) => {
    expect(() =>
      assertRepositoryUploadSessionActive(session, NOW)
    ).toThrow("Upload session is no longer active");
  });
});
