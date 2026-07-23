/**
 * @jest-environment node
 *
 * SSRF guard for server-side reference-image fetching (REV-COR-497).
 * Uses the global `jest` (not @jest/globals) so jest.mock hoisting works.
 */
import { fetchReferenceImageSafely } from "@/lib/ai/image-generation-service";

describe("fetchReferenceImageSafely — SSRF guard (REV-COR-497)", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it("rejects the cloud-metadata IP before issuing any request", async () => {
    await expect(
      fetchReferenceImageSafely("http://169.254.169.254/latest/meta-data/")
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects the ECS credentials endpoint before issuing any request", async () => {
    await expect(fetchReferenceImageSafely("http://169.254.170.2/creds")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a loopback URL before issuing any request", async () => {
    await expect(fetchReferenceImageSafely("http://127.0.0.1/x.png")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a private RFC-1918 URL before issuing any request", async () => {
    await expect(fetchReferenceImageSafely("http://10.0.0.5/x.png")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches a public URL and returns bytes + content type", async () => {
    const body = new TextEncoder().encode("PNGDATA").buffer;
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: {
        get: (k: string) => (k.toLowerCase() === "content-type" ? "image/png" : null),
      },
      arrayBuffer: async () => body,
    });
    const { data, mimeType } = await fetchReferenceImageSafely("https://example.com/ref.png");
    expect(mimeType).toBe("image/png");
    expect(Buffer.from(data).toString()).toBe("PNGDATA");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-validates redirects: a public URL that 302s to the metadata IP is rejected", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: {
        get: (k: string) =>
          k.toLowerCase() === "location" ? "http://169.254.169.254/" : null,
      },
    });
    await expect(
      fetchReferenceImageSafely("https://example.com/redirect")
    ).rejects.toThrow();
    // Hop 0 (public) fetched; hop 1 (metadata) blocked before fetching.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes an AbortSignal so a hanging origin cannot stall the request indefinitely", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "image/png" : null) },
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    await fetchReferenceImageSafely("https://example.com/ref.png");
    const options = fetchMock.mock.calls[0][1];
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects a 304 Not Modified instead of treating it as a redirect", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 304,
      ok: false,
      headers: { get: () => null },
    });
    await expect(fetchReferenceImageSafely("https://example.com/ref.png")).rejects.toThrow(
      /status 304/
    );
  });

  it("rejects a redirect response with no Location header instead of silently stopping", async () => {
    fetchMock.mockResolvedValueOnce({
      status: 302,
      ok: false,
      headers: { get: () => null },
    });
    await expect(fetchReferenceImageSafely("https://example.com/redirect")).rejects.toThrow(
      /Location/
    );
  });

  it("rejects a response whose Content-Length exceeds the size cap before buffering", async () => {
    const arrayBuffer = jest.fn();
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: {
        get: (k: string) => {
          const key = k.toLowerCase();
          if (key === "content-type") return "image/png";
          if (key === "content-length") return "50000000";
          return null;
        },
      },
      arrayBuffer,
    });
    await expect(
      fetchReferenceImageSafely("https://example.com/huge.png")
    ).rejects.toThrow(/exceeds maximum allowed size/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("bounds a streamed response with no Content-Length by size, not just the header", async () => {
    const bigChunk = new Uint8Array(6_000_000);
    let call = 0;
    const reader = {
      read: jest.fn(async () => {
        call += 1;
        if (call <= 2) return { done: false, value: bigChunk };
        return { done: true, value: undefined };
      }),
      cancel: jest.fn(async () => {}),
    };
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "image/png" : null) },
      body: { getReader: () => reader },
    });
    await expect(
      fetchReferenceImageSafely("https://example.com/stream.png")
    ).rejects.toThrow(/exceeds maximum allowed size/);
    expect(reader.cancel).toHaveBeenCalled();
  });

  it("strips Content-Type parameters so the mime type is canonical", async () => {
    const body = new TextEncoder().encode("PNGDATA").buffer;
    fetchMock.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: {
        get: (k: string) =>
          k.toLowerCase() === "content-type" ? "image/png; charset=binary" : null,
      },
      arrayBuffer: async () => body,
    });
    const { mimeType } = await fetchReferenceImageSafely("https://example.com/ref.png");
    expect(mimeType).toBe("image/png");
  });
});
