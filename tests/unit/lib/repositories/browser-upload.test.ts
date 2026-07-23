/** @jest-environment jsdom */

import { uploadFileToRepositoryStorage } from "@/lib/repositories/content-platform/browser-upload";

function storageResponse(
  ok: boolean,
  headers: Record<string, string> = {}
): Response {
  return {
    ok,
    headers: {
      get(name: string) {
        const entry = Object.entries(headers).find(
          ([key]) => key.toLowerCase() === name.toLowerCase()
        );
        return entry?.[1] ?? null;
      },
    } as Headers,
  } as Response;
}

describe("browser canonical repository upload", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("puts a single upload directly to object storage", async () => {
    const fetchMock = jest.fn().mockResolvedValue(storageResponse(true));
    global.fetch = fetchMock as typeof fetch;
    const file = new File(["source"], "notes.txt", { type: "text/plain" });

    const parts = await uploadFileToRepositoryStorage(
      file,
      {
        sessionId: "session-1",
        uploadMethod: "single",
        uploadUrl: "https://storage.example/source",
      },
      "text/plain"
    );

    expect(parts).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://storage.example/source",
      expect.objectContaining({
        method: "PUT",
        body: file,
        headers: {
          "Content-Type": "text/plain",
          "If-None-Match": "*",
          "x-amz-tagging": "aistudio-upload-state=temporary",
        },
      })
    );
  });

  it("uploads bounded Blob slices and returns ordered multipart ETags", async () => {
    const fetchMock = jest.fn(
      async (
        url: string | URL | Request,
        _init?: RequestInit
      ): Promise<Response> => {
        const partNumber = Number(String(url).at(-1));
        return storageResponse(true, { ETag: `etag-${partNumber}` });
      }
    );
    global.fetch = fetchMock as typeof fetch;
    const file = new File(["abcdefghijk"], "large.txt", {
      type: "text/plain",
    });

    const parts = await uploadFileToRepositoryStorage(
      file,
      {
        sessionId: "session-2",
        uploadMethod: "multipart",
        partSize: 5,
        partUrls: [
          { partNumber: 1, uploadUrl: "https://storage.example/1" },
          { partNumber: 2, uploadUrl: "https://storage.example/2" },
          { partNumber: 3, uploadUrl: "https://storage.example/3" },
        ],
      },
      "text/plain"
    );

    expect(parts).toEqual([
      { ETag: "etag-1", PartNumber: 1 },
      { ETag: "etag-2", PartNumber: 2 },
      { ETag: "etag-3", PartNumber: 3 },
    ]);
    const uploadedBodies = fetchMock.mock.calls.map(
      ([, init]) => init?.body
    );
    expect(uploadedBodies).toHaveLength(3);
    expect(uploadedBodies.every((body) => body instanceof Blob)).toBe(true);
  });

  it("fails when storage omits a multipart ETag", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(storageResponse(true)) as typeof fetch;
    const file = new File(["source"], "notes.txt", { type: "text/plain" });

    await expect(
      uploadFileToRepositoryStorage(
        file,
        {
          sessionId: "session-3",
          uploadMethod: "multipart",
          partSize: 5,
          partUrls: [
            { partNumber: 1, uploadUrl: "https://storage.example/1" },
          ],
        },
        "text/plain"
      )
    ).rejects.toThrow("did not return an ETag");
  });
});
