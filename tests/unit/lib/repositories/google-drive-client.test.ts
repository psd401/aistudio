/** @jest-environment node */

import {
  GoogleDriveClient,
  GoogleDriveDownloadPendingError,
} from "@/lib/repositories/google-drive/drive-client";
import {
  exportedGoogleDriveFileName,
  GOOGLE_DRIVE_SCOPE,
  resolveGoogleDriveExportFormat,
} from "@/lib/repositories/google-drive/formats";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as Response;
}

function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: async () => body,
  } as unknown as Response;
}

describe("GoogleDriveClient", () => {
  test("requests metadata with read-only authorization and Shared Drive fields", async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        jsonResponse({
          id: "file-1",
          name: "Handbook",
          mimeType: "application/vnd.google-apps.document",
        }),
      );
    const client = new GoogleDriveClient("access-token", {
      fetch: fetchMock,
    });

    const file = await client.getFile("file-1");

    expect(file.id).toBe("file-1");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const requestUrl = new URL(String(url));
    expect(requestUrl.pathname).toBe("/drive/v3/files/file-1");
    expect(requestUrl.searchParams.get("supportsAllDrives")).toBe("true");
    expect(requestUrl.searchParams.get("fields")).toContain(
      "shortcutDetails(targetId,targetMimeType,targetResourceKey)",
    );
    expect(requestUrl.searchParams.get("fields")).not.toContain(
      "shortcutDetails(targetId,targetMimeType,resourceKey)",
    );
    expect(init?.headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer access-token" }),
    );
    expect(GOOGLE_DRIVE_SCOPE).toBe(
      "https://www.googleapis.com/auth/drive.readonly",
    );
  });

  test("uses a shortcut target resource key for link-shared metadata", async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        jsonResponse({
          id: "target-file",
          name: "Linked handbook",
          mimeType: "application/vnd.google-apps.document",
        }),
      );
    const client = new GoogleDriveClient("access-token", {
      fetch: fetchMock,
    });

    await client.getFile("target-file", "target-resource-key");

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer access-token",
        "X-Goog-Drive-Resource-Keys":
          "target-file/target-resource-key",
      }),
    );
  });

  test("preserves Drive change cursors", async () => {
    const fetchMock = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        jsonResponse({
          nextPageToken: "next-page",
          changes: [
            {
              fileId: "file-1",
              removed: true,
            },
          ],
        }),
      );
    const page = await new GoogleDriveClient("token", {
      fetch: fetchMock,
    }).listChanges("cursor-1", "drive-1");

    expect(page.nextPageToken).toBe("next-page");
    expect(page.newStartPageToken).toBeNull();
    expect(page.values).toEqual([
      expect.objectContaining({ fileId: "file-1", removed: true }),
    ]);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "pageToken=cursor-1",
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("driveId=drive-1");
  });

  test("tracks and resumes long-running Google Vids downloads", async () => {
    const pendingFetch = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValue(
        jsonResponse({ name: "operations/download-1", done: false }),
      );
    const client = new GoogleDriveClient("token", { fetch: pendingFetch });
    const file = {
      id: "vid-1",
      name: "Orientation",
      mimeType: "application/vnd.google-apps.vid",
      parents: [],
      owners: [],
      trashed: false,
    };
    const format = resolveGoogleDriveExportFormat(file.mimeType);
    expect(format).not.toBeNull();

    await expect(client.downloadFile(file, format!)).rejects.toEqual(
      expect.objectContaining<Partial<GoogleDriveDownloadPendingError>>({
        operationName: "operations/download-1",
      }),
    );

    const resumedFetch = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(
        jsonResponse({
          name: "operations/download-1",
          done: true,
          response: { downloadUri: "https://download.example.test/video" },
        }),
      )
      .mockResolvedValueOnce(textResponse("video-bytes"));
    const resumed = await new GoogleDriveClient("token", {
      fetch: resumedFetch,
    }).downloadFile(file, format!, "operations/download-1");

    expect(String(resumedFetch.mock.calls[0]?.[0])).toContain(
      "/drive/v3/operations/download-1",
    );
    expect(String(resumedFetch.mock.calls[0]?.[0])).not.toContain(
      "operations/operations",
    );
    expect(await resumed.response.text()).toBe("video-bytes");
  });
});

describe("Google Drive canonical format mapping", () => {
  test.each([
    [
      "application/vnd.google-apps.document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".docx",
    ],
    [
      "application/vnd.google-apps.spreadsheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".xlsx",
    ],
    [
      "application/vnd.google-apps.presentation",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".pptx",
    ],
    ["application/vnd.google-apps.drawing", "application/pdf", ".pdf"],
  ])("exports %s to %s", (source, contentType, extension) => {
    const format = resolveGoogleDriveExportFormat(source);
    expect(format).toEqual(expect.objectContaining({ contentType, extension }));
  });

  test("rejects unsupported native Workspace types without guessing", () => {
    expect(
      resolveGoogleDriveExportFormat("application/vnd.google-apps.form"),
    ).toBeNull();
  });

  test("normalizes Drive vendor text types to the canonical text contract", () => {
    expect(resolveGoogleDriveExportFormat("text/x-python")).toEqual({
      contentType: "text/plain",
      extension: "",
      method: "blob",
      repositoryItemType: "text",
    });
    expect(resolveGoogleDriveExportFormat("text/markdown")?.contentType).toBe(
      "text/markdown",
    );
    expect(resolveGoogleDriveExportFormat("text/csv")?.contentType).toBe(
      "text/csv",
    );
  });

  test("sanitizes exported source names", () => {
    const format = resolveGoogleDriveExportFormat(
      "application/vnd.google-apps.document",
    );
    expect(exportedGoogleDriveFileName("../Staff / Handbook", format!)).toBe(
      "_Staff _ Handbook.docx",
    );
  });
});
