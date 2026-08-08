/** @jest-environment node */

import {
  GoogleDriveClient,
  GoogleDriveUnreadableFileError,
} from "@/lib/repositories/google-drive/drive-client";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as Response;
}

function fileEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `File ${id}`,
    mimeType: "application/vnd.google-apps.document",
    ...overrides,
  };
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

  test("keeps every well-formed entry when one entry is malformed", async () => {
    // Regression class: one poisoned entry among a thousand used to reject the
    // whole page, so the cursor never advanced and the connector stalled —
    // exactly the original fileId incident with a different field.
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        jsonResponse({
          nextPageToken: "page-2",
          changes: [
            { changeType: "file", fileId: "file-1", file: fileEntry("file-1") },
            // `file.name` is a number: not representable, so this entry alone
            // is dropped.
            {
              changeType: "file",
              fileId: "file-2",
              file: { ...fileEntry("file-2"), name: 42 },
            },
            { changeType: "file", fileId: "file-3", file: fileEntry("file-3") },
          ],
        }),
      );

    const page = await new GoogleDriveClient("token", {
      fetch: fetchMock,
    }).listChanges("cursor-1");

    expect(page.values.map((change) => change.fileId)).toEqual([
      "file-1",
      "file-3",
    ]);
    // The page still yields its continuation token, so the cursor advances.
    expect(page.nextPageToken).toBe("page-2");
    expect(page.skippedEntries).toHaveLength(1);
    expect(page.skippedEntries[0]).toEqual(
      expect.objectContaining({ index: 1, id: "file-2" }),
    );
    expect(page.skippedEntries[0]?.issues[0]?.path).toBe("file.name");
    expect(page.skippedEntries[0]?.issues[0]?.message).toEqual(
      expect.any(String),
    );
  });

  test("extracts an identifier from a malformed entry when one is present", async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        jsonResponse({
          newStartPageToken: "start-9",
          changes: [{ fileId: 12, file: { id: "nested-1" } }, "not-an-object"],
        }),
      );

    const page = await new GoogleDriveClient("token", {
      fetch: fetchMock,
    }).listChanges("cursor-1");

    expect(page.values).toHaveLength(0);
    expect(page.skippedEntries.map((entry) => entry.id)).toEqual([
      "nested-1",
      null,
    ]);
  });

  test("reports no skipped entries for a healthy page", async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        jsonResponse({
          newStartPageToken: "start-4",
          changes: [{ changeType: "file", fileId: "file-1" }],
        }),
      );

    const page = await new GoogleDriveClient("token", {
      fetch: fetchMock,
    }).listChanges("cursor-1");

    expect(page.skippedEntries).toEqual([]);
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

describe("GoogleDriveClient file entry tolerance", () => {
  async function listOneFile(overrides: Record<string, unknown>) {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        jsonResponse({ files: [fileEntry("file-1", overrides)] }),
      );
    const page = await new GoogleDriveClient("token", {
      fetch: fetchMock,
    }).listChildren("folder-1");
    return page;
  }

  test("accepts timestamps Google formats without a UTC offset", async () => {
    // The only consumers are `new Date(...)` and a revision string; a strict
    // RFC-3339-with-offset validator would have rejected the whole page.
    const page = await listOneFile({ modifiedTime: "2026-08-06T12:00:00Z" });
    expect(page.skippedEntries).toEqual([]);
    expect(page.values[0]?.modifiedTime).toBe("2026-08-06T12:00:00Z");
  });

  test("drops an unparseable timestamp instead of importing an Invalid Date", async () => {
    // Accepting the entry is right — rejecting it would be the poison-page
    // class. Carrying the raw string through is not: `sourceIdentityFields`
    // feeds modifiedTime to `new Date(...)` and a timestamp column, so an
    // Invalid Date fails the import transaction. And because the entry
    // validated, it is not counted as a skipped entry, so the cursor advances
    // and the unseen-source sweep is not suppressed — the file would stay
    // unimported indefinitely rather than being retried.
    const page = await listOneFile({ modifiedTime: "not-a-timestamp" });
    expect(page.skippedEntries).toEqual([]);
    expect(page.values[0]?.id).toBe("file-1");
    expect(page.values[0]?.modifiedTime).toBeUndefined();
  });

  test("accepts a non-numeric size instead of rejecting the entry", async () => {
    // The streaming byte bound is authoritative, so a surprising size string
    // must not cost us the file.
    const page = await listOneFile({ size: "unknown" });
    expect(page.skippedEntries).toEqual([]);
    expect(page.values[0]?.size).toBe("unknown");
  });

  test("keeps http(s) links and drops non-navigable schemes", async () => {
    const kept = await listOneFile({
      webViewLink: "https://drive.example.test/d/file-1",
      iconLink: "http://drive.example.test/icon.png",
    });
    expect(kept.values[0]?.webViewLink).toBe(
      "https://drive.example.test/d/file-1",
    );
    expect(kept.values[0]?.iconLink).toBe("http://drive.example.test/icon.png");

    // Loosening the URL validator must not make the field an injection
    // vector: a non-http(s) scheme is dropped, not persisted.
    const dropped = await listOneFile({
      webViewLink: "javascript:alert(1)",
      iconLink: "data:text/html,<script>",
    });
    expect(dropped.skippedEntries).toEqual([]);
    expect(dropped.values[0]?.webViewLink).toBeUndefined();
    expect(dropped.values[0]?.iconLink).toBeUndefined();
  });

  test("accepts explicit nulls where Google could send them", async () => {
    const page = await listOneFile({
      parents: null,
      driveId: null,
      owners: null,
      trashed: null,
      modifiedTime: null,
      md5Checksum: null,
      shortcutDetails: null,
    });
    expect(page.skippedEntries).toEqual([]);
    expect(page.values[0]?.parents).toEqual([]);
    expect(page.values[0]?.owners).toEqual([]);
    expect(page.values[0]?.trashed).toBe(false);
    expect(page.values[0]?.driveId).toBeUndefined();
  });

  test("accepts a shortcut that omits targetMimeType", async () => {
    // targetMimeType has no reader; only targetId is dereferenced, and its
    // absence already has a graceful "no target" path.
    const page = await listOneFile({
      mimeType: "application/vnd.google-apps.shortcut",
      shortcutDetails: { targetId: "target-1" },
    });
    expect(page.skippedEntries).toEqual([]);
    expect(page.values[0]?.shortcutDetails?.targetId).toBe("target-1");
    expect(page.values[0]?.shortcutDetails?.targetMimeType).toBeUndefined();
  });

  test("accepts a shortcut that omits targetId, leaving the graceful path", async () => {
    const page = await listOneFile({
      mimeType: "application/vnd.google-apps.shortcut",
      shortcutDetails: { targetMimeType: "application/pdf" },
    });
    expect(page.skippedEntries).toEqual([]);
    expect(page.values[0]?.shortcutDetails?.targetId).toBeUndefined();
  });

  test("skips only the malformed child and still paginates", async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        jsonResponse({
          nextPageToken: "page-2",
          files: [
            fileEntry("file-1"),
            { ...fileEntry("file-2"), mimeType: null },
            fileEntry("file-3"),
          ],
        }),
      );

    const page = await new GoogleDriveClient("token", {
      fetch: fetchMock,
    }).listChildren("folder-1");

    expect(page.values.map((file) => file.id)).toEqual(["file-1", "file-3"]);
    expect(page.nextPageToken).toBe("page-2");
    expect(page.skippedEntries).toEqual([
      expect.objectContaining({ index: 1, id: "file-2" }),
    ]);
  });

  test("skips only the malformed entry when enumerating a Shared Drive", async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        jsonResponse({
          files: [{ name: "no id" }, fileEntry("file-9")],
        }),
      );

    const page = await new GoogleDriveClient("token", {
      fetch: fetchMock,
    }).listSharedDriveFiles("drive-1");

    expect(page.values.map((file) => file.id)).toEqual(["file-9"]);
    expect(page.skippedEntries).toEqual([
      expect.objectContaining({ index: 0, id: null }),
    ]);
  });
});

describe("GoogleDriveClient getFile", () => {
  test("throws the typed unreadable-file error, not a raw ZodError", async () => {
    // getFile backs shortcut resolution and the parent-selection walk during
    // change processing. A ZodError escaping here is unclassifiable to the
    // caller and would fail the whole run — replaying the page until the DLQ,
    // the same poison pattern the per-entry list parsing eliminates.
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        jsonResponse({ id: "file-1", name: 42, mimeType: "application/pdf" }),
      );

    const pending = new GoogleDriveClient("token", {
      fetch: fetchMock,
    }).getFile("file-1");

    await expect(pending).rejects.toBeInstanceOf(
      GoogleDriveUnreadableFileError,
    );
    await expect(pending).rejects.toMatchObject({
      fileId: "file-1",
      issues: [expect.objectContaining({ path: "name" })],
    });
  });

  test("returns a healthy file record", async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(jsonResponse(fileEntry("file-1")));

    const file = await new GoogleDriveClient("token", {
      fetch: fetchMock,
    }).getFile("file-1");

    expect(file.id).toBe("file-1");
  });
});
