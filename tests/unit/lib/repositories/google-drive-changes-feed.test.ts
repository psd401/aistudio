/** @jest-environment node */

import { GoogleDriveClient } from "@/lib/repositories/google-drive/drive-client";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as Response;
}

describe("GoogleDriveClient changes feed", () => {
  test("accepts Shared Drive-scoped change entries that carry no fileId", async () => {
    // Regression: Google emits changeType "drive" entries (Shared Drive
    // rename/membership/restriction events) with no fileId. Requiring fileId
    // made listChanges throw before the cursor advanced, so the sync Lambda
    // retried the same page forever and the queue filled with poison messages.
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        jsonResponse({
          newStartPageToken: "start-2",
          changes: [
            {
              changeType: "drive",
              time: "2026-08-06T12:00:00.000Z",
              driveId: "drive-1",
            },
            {
              changeType: "file",
              fileId: "file-1",
              time: "2026-08-06T12:00:01.000Z",
            },
          ],
        }),
      );

    const page = await new GoogleDriveClient("token", {
      fetch: fetchMock,
    }).listChanges("cursor-1", "drive-1");

    expect(page.values).toHaveLength(2);
    expect(page.values[0]).toEqual(
      expect.objectContaining({ changeType: "drive", driveId: "drive-1" }),
    );
    expect(page.values[0]?.fileId).toBeUndefined();
    expect(page.values[1]).toEqual(
      expect.objectContaining({ changeType: "file", fileId: "file-1" }),
    );
    expect(page.newStartPageToken).toBe("start-2");
  });

  test("tolerates change types Google has not shipped yet", async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        jsonResponse({
          newStartPageToken: "start-3",
          changes: [{ changeType: "someFutureScope" }],
        }),
      );

    const page = await new GoogleDriveClient("token", {
      fetch: fetchMock,
    }).listChanges("cursor-1");

    expect(page.values).toEqual([
      expect.objectContaining({ changeType: "someFutureScope" }),
    ]);
  });

  test("requests changeType in the changes fields projection", async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(jsonResponse({ newStartPageToken: "start-1" }));

    await new GoogleDriveClient("token", { fetch: fetchMock }).listChanges(
      "cursor-1",
    );

    const fields = new URL(
      String(fetchMock.mock.calls[0]?.[0]),
    ).searchParams.get("fields");
    expect(fields).toContain("changes(changeType,fileId,");
  });

});
