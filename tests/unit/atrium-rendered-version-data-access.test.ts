/** @jest-environment node */

/**
 * `resolveRenderedVersionAccess` — the bridge's version-scoped capability gate
 * (#1789).
 *
 * Every `AtriumData` operation is authorized against the mode stamped on the
 * version the page is RENDERING, not the object's current mode. That is what
 * stops an author's draft-time mode flip from re-capabilitying the Live `/c/`
 * page for every reader (issue #1789, scenarios A and B).
 *
 * The version id arrives from a trusted page prop but still crosses the client,
 * so the resolver verifies it belongs to the object rather than believing it.
 */

const getByIdMock = jest.fn();
jest.mock("@/lib/content", () => ({
  versionService: { getById: (...a: unknown[]) => getByIdMock(...a) },
}));

import { resolveRenderedVersionAccess } from "@/actions/db/atrium/artifact-guards";

const log = {
  warn: jest.fn(),
} as unknown as Parameters<typeof resolveRenderedVersionAccess>[2];

const CONTENT = {
  id: "obj-1",
  currentVersionId: "ver-head",
  dataAccess: "query" as const,
};

beforeEach(() => {
  getByIdMock.mockReset();
  (log.warn as jest.Mock).mockClear();
});

describe("resolveRenderedVersionAccess", () => {
  it("answers with the head — and no lookup — when no version is requested", async () => {
    const result = await resolveRenderedVersionAccess(CONTENT, undefined, log);

    expect(result).toEqual({ versionId: "ver-head", dataAccess: "query" });
    expect(getByIdMock).not.toHaveBeenCalled();
  });

  it("answers with the head — and no lookup — when the head is what is running", async () => {
    const result = await resolveRenderedVersionAccess(CONTENT, "ver-head", log);

    expect(result).toEqual({ versionId: "ver-head", dataAccess: "query" });
    expect(getByIdMock).not.toHaveBeenCalled();
  });

  it("uses the RENDERED version's stamp, not the object's mode", async () => {
    // The Live page: v3 was published in `records` mode; the object has since
    // moved to `query` for the author's draft.
    getByIdMock.mockResolvedValue({ id: "ver-published", dataAccess: "records" });

    const result = await resolveRenderedVersionAccess(
      CONTENT,
      "ver-published",
      log
    );

    expect(result).toEqual({
      versionId: "ver-published",
      dataAccess: "records",
    });
  });

  it("falls back to the object's mode for a version predating migration 183", async () => {
    getByIdMock.mockResolvedValue({ id: "ver-old", dataAccess: null });

    const result = await resolveRenderedVersionAccess(CONTENT, "ver-old", log);

    expect(result).toEqual({ versionId: "ver-old", dataAccess: "query" });
  });

  it("refuses a version id that does not belong to this artifact", async () => {
    // `getById` is scoped by object id, so a foreign version simply is not
    // found — it can never lend its capability to this artifact.
    getByIdMock.mockResolvedValue(null);

    await expect(
      resolveRenderedVersionAccess(CONTENT, "ver-of-another-object", log)
    ).rejects.toThrow(/versionId/);
  });

  it("falls back to the head (and logs) when the lookup itself fails", async () => {
    // A DB blip must not fail an otherwise healthy operation: the lookup only
    // chooses which version answers.
    getByIdMock.mockRejectedValue(new Error("connection reset"));

    const result = await resolveRenderedVersionAccess(CONTENT, "ver-x", log);

    expect(result).toEqual({ versionId: "ver-head", dataAccess: "query" });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("ignores a blank or non-string requested version", async () => {
    await expect(
      resolveRenderedVersionAccess(CONTENT, "   ", log)
    ).resolves.toEqual({ versionId: "ver-head", dataAccess: "query" });
    await expect(
      resolveRenderedVersionAccess(CONTENT, 42, log)
    ).resolves.toEqual({ versionId: "ver-head", dataAccess: "query" });
    expect(getByIdMock).not.toHaveBeenCalled();
  });

  it("trims a padded version id before comparing and looking up", async () => {
    getByIdMock.mockResolvedValue({ id: "ver-published", dataAccess: "none" });

    const result = await resolveRenderedVersionAccess(
      CONTENT,
      "  ver-published  ",
      log
    );

    expect(getByIdMock).toHaveBeenCalledWith("obj-1", "ver-published");
    expect(result.dataAccess).toBe("none");
  });
});
