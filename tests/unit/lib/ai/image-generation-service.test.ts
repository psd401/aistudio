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
});
