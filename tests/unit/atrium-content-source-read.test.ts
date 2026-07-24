const mockGet = jest.fn();
const mockGetById = jest.fn();
const mockLoadSource = jest.fn();

jest.mock("@/lib/content/content-service", () => ({
  contentService: { get: (...args: unknown[]) => mockGet(...args) },
}));
jest.mock("@/lib/content/version-service", () => ({
  versionService: {
    getById: (...args: unknown[]) => mockGetById(...args),
    loadSource: (...args: unknown[]) => mockLoadSource(...args),
  },
}));

import {
  contentSourceEtag,
  contentSourceService,
  ifNoneMatchIncludes,
} from "@/lib/content/source-read";
import { NotFoundError } from "@/lib/content/errors";

const requester = {
  kind: "user" as const,
  userId: 7,
  roles: ["staff"],
  isAdmin: false,
};
const currentVersion = {
  id: "11111111-2222-4333-8444-555555555555",
  objectId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  versionNumber: 2,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue({
    id: currentVersion.objectId,
    version: currentVersion,
  });
  mockLoadSource.mockResolvedValue({
    objectId: currentVersion.objectId,
    versionId: currentVersion.id,
    versionNumber: 2,
    bodyFormat: "markdown",
    body: "# Guide",
    sha256: "hash",
  });
});

describe("contentSourceService (#1288)", () => {
  it("reads the current committed version after the object visibility check", async () => {
    const source = await contentSourceService.read(requester, "guide");
    expect(mockGet).toHaveBeenCalledWith(requester, "guide");
    expect(mockGetById).not.toHaveBeenCalled();
    expect(mockLoadSource).toHaveBeenCalledWith(currentVersion);
    expect(source.body).toBe("# Guide");
  });

  it("scopes a historic version id to the already-authorized object", async () => {
    const historic = { ...currentVersion, id: "historic-version" };
    mockGetById.mockResolvedValue(historic);
    await contentSourceService.read(requester, "guide", "historic-version");
    expect(mockGetById).toHaveBeenCalledWith(
      currentVersion.objectId,
      "historic-version"
    );
    expect(mockLoadSource).toHaveBeenCalledWith(historic);
  });

  it("404-masks a foreign or absent historic version without reading storage", async () => {
    mockGetById.mockResolvedValue(null);
    await expect(
      contentSourceService.read(requester, "guide", "foreign-version")
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(mockLoadSource).not.toHaveBeenCalled();
  });
});

describe("source ETags", () => {
  const etag = '"11111111-2222-4333-8444-555555555555"';

  it("quotes the immutable version id", () => {
    expect(contentSourceEtag(currentVersion.id)).toBe(etag);
  });

  it.each([
    etag,
    `W/${etag}`,
    `"other", ${etag}`,
    "*",
  ])("matches If-None-Match validator %s", (header) => {
    expect(ifNoneMatchIncludes(header, etag)).toBe(true);
  });

  it("does not match a stale current-source validator", () => {
    expect(ifNoneMatchIncludes('"older-version"', etag)).toBe(false);
  });
});
