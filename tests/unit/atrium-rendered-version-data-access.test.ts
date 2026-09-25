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
 * The version id is caller-controlled at the RPC boundary, so a READER's id is
 * ignored (the server pins them to the Live version, else the head) and an
 * EDITOR's id is verified to belong to the object rather than believed.
 */

const getByIdMock = jest.fn();
const livePublishedVersionIdMock = jest.fn();
jest.mock("@/lib/content", () => ({
  versionService: { getById: (...a: unknown[]) => getByIdMock(...a) },
}));
jest.mock("@/lib/content/live-publication", () => ({
  livePublishedVersionId: (...a: unknown[]) => livePublishedVersionIdMock(...a),
}));

import { resolveRenderedVersionAccess } from "@/actions/db/atrium/artifact-guards";

const log = {
  warn: jest.fn(),
} as unknown as Parameters<typeof resolveRenderedVersionAccess>[3];

const CONTENT = {
  id: "obj-1",
  currentVersionId: "ver-head",
  dataAccess: "query" as const,
};

const VERSIONS: Record<string, { id: string; dataAccess: string | null }> = {
  "ver-head": { id: "ver-head", dataAccess: "query" },
  "ver-published": { id: "ver-published", dataAccess: "records" },
  "ver-old": { id: "ver-old", dataAccess: null },
  "ver-none": { id: "ver-none", dataAccess: "none" },
};

beforeEach(() => {
  getByIdMock.mockReset();
  getByIdMock.mockImplementation(async (_obj: string, id: string) => VERSIONS[id] ?? null);
  livePublishedVersionIdMock.mockReset();
  livePublishedVersionIdMock.mockResolvedValue(null);
  (log.warn as jest.Mock).mockClear();
});

describe("resolveRenderedVersionAccess — editor", () => {
  it("answers with the head's OWN stamp when no version is requested", async () => {
    getByIdMock.mockResolvedValueOnce({ id: "ver-head", dataAccess: "records" });

    const result = await resolveRenderedVersionAccess(CONTENT, true, undefined, log);

    // The head's stamp wins over the object's mode: a mode write that reached
    // the object but not the versions cannot re-capability what is running.
    expect(result).toEqual({ versionId: "ver-head", dataAccess: "records" });
    expect(getByIdMock).toHaveBeenCalledWith("obj-1", "ver-head");
    expect(livePublishedVersionIdMock).not.toHaveBeenCalled();
  });

  it("uses the REQUESTED version's stamp, not the object's mode", async () => {
    const result = await resolveRenderedVersionAccess(
      CONTENT,
      true,
      "ver-published",
      log
    );

    expect(result).toEqual({ versionId: "ver-published", dataAccess: "records" });
  });

  it("falls back to the object's mode for a version predating migration 183", async () => {
    const result = await resolveRenderedVersionAccess(CONTENT, true, "ver-old", log);

    expect(result).toEqual({ versionId: "ver-old", dataAccess: "query" });
  });

  it("refuses a version id that does not belong to this artifact", async () => {
    // `getById` is scoped by object id, so a foreign version simply is not
    // found — it can never lend its capability to this artifact.
    await expect(
      resolveRenderedVersionAccess(CONTENT, true, "ver-of-another-object", log)
    ).rejects.toThrow(/versionId/);
  });

  it("falls back to the head (and logs) when the lookup itself fails", async () => {
    // A DB blip must not fail an otherwise healthy operation: the lookup only
    // chooses which version answers.
    getByIdMock.mockRejectedValue(new Error("connection reset"));

    const result = await resolveRenderedVersionAccess(CONTENT, true, "ver-x", log);

    expect(result).toEqual({ versionId: "ver-head", dataAccess: "query" });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("treats a blank or non-string requested version as the head", async () => {
    await expect(
      resolveRenderedVersionAccess(CONTENT, true, "   ", log)
    ).resolves.toEqual({ versionId: "ver-head", dataAccess: "query" });
    await expect(
      resolveRenderedVersionAccess(CONTENT, true, 42, log)
    ).resolves.toEqual({ versionId: "ver-head", dataAccess: "query" });
    expect(getByIdMock).toHaveBeenCalledWith("obj-1", "ver-head");
  });

  it("trims a padded version id before looking it up", async () => {
    const result = await resolveRenderedVersionAccess(
      CONTENT,
      true,
      "  ver-none  ",
      log
    );

    expect(getByIdMock).toHaveBeenCalledWith("obj-1", "ver-none");
    expect(result.dataAccess).toBe("none");
  });
});

describe("resolveRenderedVersionAccess — reader", () => {
  it("pins a reader to the Live version, whatever they request", async () => {
    livePublishedVersionIdMock.mockResolvedValue("ver-published");

    // A reader can enumerate version ids (listVersionsAction is view-gated) and
    // call the action directly; their id must never choose the mode.
    const result = await resolveRenderedVersionAccess(CONTENT, false, "ver-none", log);

    expect(result).toEqual({ versionId: "ver-published", dataAccess: "records" });
    expect(getByIdMock).toHaveBeenCalledTimes(1);
    expect(getByIdMock).toHaveBeenCalledWith("obj-1", "ver-published");
  });

  it("cannot reach both records and query on one artifact via two old versions", async () => {
    // The exclusivity-loop regression: one version stamped `records`, another
    // `query`. A reader asking for each still gets the single Live answer.
    livePublishedVersionIdMock.mockResolvedValue("ver-published");

    const a = await resolveRenderedVersionAccess(CONTENT, false, "ver-published", log);
    const b = await resolveRenderedVersionAccess(CONTENT, false, "ver-head", log);

    expect(a.dataAccess).toBe("records");
    expect(b.dataAccess).toBe("records");
  });

  it("pins a reader to the head when the object is not Live", async () => {
    const result = await resolveRenderedVersionAccess(CONTENT, false, "ver-published", log);

    expect(result).toEqual({ versionId: "ver-head", dataAccess: "query" });
  });

  it("never refuses a reader over a foreign id — it is simply ignored", async () => {
    await expect(
      resolveRenderedVersionAccess(CONTENT, false, "ver-of-another-object", log)
    ).resolves.toEqual({ versionId: "ver-head", dataAccess: "query" });
  });

  it("falls back to the head under the object's mode when the Live lookup fails", async () => {
    livePublishedVersionIdMock.mockRejectedValue(new Error("connection reset"));

    const result = await resolveRenderedVersionAccess(CONTENT, false, undefined, log);

    expect(result).toEqual({ versionId: "ver-head", dataAccess: "query" });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
