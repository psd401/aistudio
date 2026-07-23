/** @jest-environment jsdom */

import {
  uploadTemporaryAttachment,
  waitForTemporaryAttachment,
} from "@/lib/repositories/temporary-attachment-client";

function response(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    headers: {
      get: () => null,
    } as unknown as Headers,
  } as Response;
}

describe("temporary attachment browser upload", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("initiates, uploads directly to storage, then owner-bound completes", async () => {
    const bindingId = "123e4567-e89b-42d3-a456-426614174001";
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        response({
          mode: "canonical",
          bindingId,
          repositoryId: 11,
          upload: {
            sessionId: "123e4567-e89b-42d3-a456-426614174003",
            uploadMethod: "single",
            uploadUrl: "https://storage.example/source",
          },
        })
      )
      .mockResolvedValueOnce(response(null))
      .mockResolvedValueOnce(
        response({
          mode: "canonical",
          reference: { bindingId, itemId: 31, name: "notes.txt" },
          repositoryId: 11,
          itemVersionId: "version-1",
          processingJobId: "job-1",
        })
      );
    global.fetch = fetchMock as typeof fetch;
    const file = new File(["source"], "notes.txt", { type: "text/plain" });

    const result = await uploadTemporaryAttachment({
      file,
      draftKey: "123e4567-e89b-42d3-a456-426614174000",
      purpose: "nexus",
    });

    expect(result).toMatchObject({
      mode: "canonical",
      reference: { bindingId, itemId: 31 },
    });
    const initiateCall = fetchMock.mock.calls[0];
    expect(initiateCall?.[0]).toBe("/api/repositories/temporary-attachments");
    const initiateBody = JSON.parse(
      String((initiateCall?.[1] as RequestInit | undefined)?.body)
    ) as Record<string, unknown>;
    expect(initiateBody).toMatchObject({
      fileName: "notes.txt",
      contentType: "text/plain",
      byteSize: 6,
    });
    expect(initiateBody).not.toHaveProperty("file");

    expect(fetchMock.mock.calls[1]).toEqual([
      "https://storage.example/source",
      expect.objectContaining({ method: "PUT", body: file }),
    ]);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `/api/repositories/temporary-attachments/${bindingId}/complete`
    );
  });

  it("returns legacy mode without uploading when the rollout is disabled", async () => {
    const fetchMock = jest.fn().mockResolvedValue(response({ mode: "legacy" }));
    global.fetch = fetchMock as typeof fetch;

    await expect(
      uploadTemporaryAttachment({
        file: new File(["source"], "notes.txt", { type: "text/plain" }),
        draftKey: "123e4567-e89b-42d3-a456-426614174000",
        purpose: "assistant-architect",
      })
    ).resolves.toEqual({ mode: "legacy" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("waits through extraction completion until the active generation is ready", async () => {
    const upload = {
      mode: "canonical" as const,
      reference: {
        bindingId: "123e4567-e89b-42d3-a456-426614174001",
        itemId: 31,
        name: "notes.txt",
      },
      repositoryId: 11,
      itemVersionId: "version-1",
      processingJobId: "job-1",
    };
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(response({ status: "processing_embeddings" }))
      .mockResolvedValueOnce(response({ status: "embedded" }));
    global.fetch = fetchMock as typeof fetch;

    await expect(
      waitForTemporaryAttachment(upload, {
        maxAttempts: 2,
        initialDelayMs: 0,
      })
    ).resolves.toContain(
      "repository-attachment:v1:123e4567-e89b-42d3-a456-426614174001:31"
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
