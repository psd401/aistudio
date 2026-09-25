/**
 * A save to a Live object is the update: `versionService.snapshotScreened`
 * advances the Live publication onto the new head — but only AFTER the version's
 * S3 blobs are flushed, so the Live page never points at a body that is not yet
 * readable. The advance's own rules (review gate, data-mode change, head check)
 * live in one SQL statement and are exercised against Postgres separately.
 */

const order: string[] = [];

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(),
  // The DB half of the snapshot is not under test: resolve the committed
  // version plus one pending blob write.
  executeTransaction: jest.fn(async () => ({
    version: { id: "v2", objectId: "o1", versionNumber: 2 },
    s3Writes: [{ key: "k", body: "<p>v2</p>", contentType: "text/html" }],
  })),
}));
jest.mock("@/lib/content/storage/s3-store", () => ({
  s3Store: {
    putText: jest.fn(async () => {
      order.push("flush");
    }),
  },
}));
const advanceLiveMock = jest.fn(async (..._args: unknown[]): Promise<number> => {
  order.push("advance");
  return 1;
});
jest.mock("@/lib/content/live-publication", () => ({
  advanceLivePublications: (...args: unknown[]) => advanceLiveMock(...args),
}));
jest.mock("@/lib/content/events", () => ({
  contentEvents: { emit: jest.fn(async () => undefined) },
}));
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: { canView: jest.fn(async () => true) },
}));
jest.mock("@/lib/content/render/markdown-render", () => ({
  renderMarkdownToHtml: () => "",
}));

import { versionService } from "@/lib/content/version-service";
import type { Requester } from "@/lib/content/types";
import type { ScreeningProof } from "@/lib/content/agent-screening";

const human: Requester = { kind: "user", userId: 7, roles: ["staff"], isAdmin: false };
const proof = {} as ScreeningProof;

beforeEach(() => {
  order.length = 0;
  advanceLiveMock.mockClear();
});

describe("a save advances the Live publication", () => {
  it("advances onto the new version after its body is flushed", async () => {
    await versionService.snapshotScreened(
      human,
      { id: "o1", kind: "artifact" },
      { body: "<p>v2</p>" },
      proof
    );
    expect(advanceLiveMock).toHaveBeenCalledWith("o1", "v2");
    expect(order).toEqual(["flush", "advance"]);
  });

  it("does not advance when the body flush fails (Live keeps a readable version)", async () => {
    const { s3Store } = jest.requireMock("@/lib/content/storage/s3-store") as {
      s3Store: { putText: jest.Mock };
    };
    s3Store.putText.mockRejectedValueOnce(new Error("S3 down"));
    await expect(
      versionService.snapshotScreened(
        human,
        { id: "o1", kind: "artifact" },
        { body: "<p>v2</p>" },
        proof
      )
    ).rejects.toThrow();
    expect(advanceLiveMock).not.toHaveBeenCalled();
  });

  it("never fails the save when advancing Live throws (best-effort)", async () => {
    advanceLiveMock.mockRejectedValueOnce(new Error("db blip"));
    await expect(
      versionService.snapshotScreened(
        human,
        { id: "o1", kind: "artifact" },
        { body: "<p>v2</p>" },
        proof
      )
    ).resolves.toEqual(expect.objectContaining({ id: "v2" }));
  });
});
