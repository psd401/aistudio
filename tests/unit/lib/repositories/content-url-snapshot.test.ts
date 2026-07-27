/** @jest-environment node */

import { setSafeFetchTransportForTests } from "@/lib/security/safe-fetch";
import {
  fetchRepositoryUrlText,
  registerCanonicalUrlSnapshot,
} from "@/lib/repositories/content-platform/url-snapshot";

const mockUploadRepositoryTextSource = jest.fn();
const mockDeleteRepositoryObjectVersions = jest.fn();
const mockRegisterCanonicalUpload = jest.fn();

jest.mock("@/lib/aws/s3-client", () => ({
  deleteRepositoryObjectVersions: (...args: unknown[]) =>
    mockDeleteRepositoryObjectVersions(...args),
  uploadRepositoryTextSource: (...args: unknown[]) =>
    mockUploadRepositoryTextSource(...args),
}));
jest.mock("@/lib/repositories/content-platform/ingestion-service", () => ({
  registerCanonicalUpload: (...args: unknown[]) =>
    mockRegisterCanonicalUpload(...args),
}));

function response(input: {
  body?: string | Uint8Array;
  contentType?: string;
  contentEncoding?: string;
  contentLength?: number;
  location?: string;
  status?: number;
}): Response {
  const status = input.status ?? 200;
  const bytes =
    typeof input.body === "string"
      ? new TextEncoder().encode(input.body)
      : input.body;
  return {
    body: bytes
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        })
      : null,
    headers: {
      get(name: string) {
        if (name.toLowerCase() === "content-type") {
          return input.contentType ?? null;
        }
        if (name.toLowerCase() === "location") return input.location ?? null;
        if (name.toLowerCase() === "content-encoding") {
          return input.contentEncoding ?? null;
        }
        if (name.toLowerCase() === "content-length") {
          return input.contentLength?.toString() ?? null;
        }
        return null;
      },
    } as Headers,
    ok: status >= 200 && status < 300,
    status,
  } as Response;
}

describe("canonical repository URL snapshots", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    setSafeFetchTransportForTests(undefined);
  });

  it("revalidates redirects and strips executable markup", async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(
        response({
          status: 302,
          location: "https://content.example/final",
        }),
      )
      .mockResolvedValueOnce(
        response({
          body: "<html><body><main>Policy <strong>text</strong><script>secret()</script></main></body></html>",
          contentType: "text/html; charset=utf-8",
        }),
      );
    setSafeFetchTransportForTests(transport);

    await expect(
      fetchRepositoryUrlText("https://start.example/policy"),
    ).resolves.toBe("Policy text");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      redirect: "manual",
    });
  });

  it("rejects non-text responses before persisting bytes", async () => {
    setSafeFetchTransportForTests(
      jest
        .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockResolvedValue(
          response({
            body: new Uint8Array([0, 1, 2]),
            contentType: "application/octet-stream",
          }),
        ),
    );
    await expect(
      fetchRepositoryUrlText("https://content.example/binary"),
    ).rejects.toThrow("did not return HTML or plain text");
  });

  it("rejects oversized and compressed responses before reading source text", async () => {
    const transport = jest
      .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
      .mockResolvedValueOnce(
        response({
          body: "too large",
          contentType: "text/plain",
          contentLength: 5 * 1024 * 1024 + 1,
        }),
      )
      .mockResolvedValueOnce(
        response({
          body: "compressed",
          contentType: "text/plain",
          contentEncoding: "gzip",
        }),
      );
    setSafeFetchTransportForTests(transport);

    await expect(
      fetchRepositoryUrlText("https://content.example/large"),
    ).rejects.toThrow("exceeds the canonical snapshot size limit");
    await expect(
      fetchRepositoryUrlText("https://content.example/compressed"),
    ).rejects.toThrow("unsupported content encoding");
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      headers: expect.objectContaining({ "Accept-Encoding": "identity" }),
    });
  });

  it("rejects embedded credentials and non-standard ports before fetching", async () => {
    const transport = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >();
    setSafeFetchTransportForTests(transport);
    await expect(
      fetchRepositoryUrlText("https://user:secret@content.example/policy"),
    ).rejects.toThrow("credentials are not allowed");
    await expect(
      fetchRepositoryUrlText("https://content.example:8443/policy"),
    ).rejects.toThrow("standard HTTP or HTTPS port");
    expect(transport).not.toHaveBeenCalled();
  });

  it("removes uploaded source versions when canonical registration fails", async () => {
    setSafeFetchTransportForTests(
      jest
        .fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>()
        .mockResolvedValue(
          response({ body: "policy", contentType: "text/plain" }),
        ),
    );
    mockUploadRepositoryTextSource.mockResolvedValue({
      key: "repositories/7/source.txt",
      byteSize: 6,
    });
    mockRegisterCanonicalUpload.mockRejectedValue(
      new Error("database unavailable"),
    );
    mockDeleteRepositoryObjectVersions.mockResolvedValue(1);

    await expect(
      registerCanonicalUrlSnapshot({
        itemId: 3,
        repositoryId: 7,
        userId: 1,
        name: "Policy",
        url: "https://content.example/policy",
      }),
    ).rejects.toThrow("database unavailable");
    expect(mockDeleteRepositoryObjectVersions).toHaveBeenCalledWith(
      "repositories/7/source.txt",
    );
  });
});
