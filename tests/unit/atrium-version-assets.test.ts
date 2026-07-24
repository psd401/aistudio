import { pinVersionAssetsInTx } from "@/lib/content/asset-references";
import { ValidationError } from "@/lib/content/errors";
import type { DbTransaction } from "@/lib/db/drizzle-client";

const OBJECT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const VERSION_ID = "99999999-8888-4777-8666-555555555555";
const ASSET_A = "11111111-2222-4333-8444-555555555555";
const ASSET_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function fakeTx(readyIds: string[]): {
  tx: DbTransaction;
  values: jest.Mock;
  select: jest.Mock;
} {
  const values = jest.fn(async () => undefined);
  const select = jest.fn(() => ({
    from: () => ({
      where: async () => readyIds.map((id) => ({ id })),
    }),
  }));
  return {
    tx: {
      select,
      insert: () => ({ values }),
    } as unknown as DbTransaction,
    values,
    select,
  };
}

describe("authoritative content version assets (#1284)", () => {
  it("pins each unique ready same-object asset to the immutable version", async () => {
    const { tx, values } = fakeTx([ASSET_A, ASSET_B]);
    await pinVersionAssetsInTx(
      tx,
      OBJECT_ID,
      VERSION_ID,
      [
        `::atrium-asset{id="${ASSET_A}" alt="A"}`,
        `::atrium-asset{id="${ASSET_B}" alt="B"}`,
        `::atrium-asset{id="${ASSET_A}" alt="duplicate"}`,
      ].join("\n")
    );
    expect(values).toHaveBeenCalledWith([
      { versionId: VERSION_ID, assetId: ASSET_A },
      { versionId: VERSION_ID, assetId: ASSET_B },
    ]);
  });

  it("rejects a missing, unready, or cross-object asset before pinning", async () => {
    const { tx, values } = fakeTx([ASSET_A]);
    await expect(
      pinVersionAssetsInTx(
        tx,
        OBJECT_ID,
        VERSION_ID,
        [
          `::atrium-asset{id="${ASSET_A}" alt="ready"}`,
          `::atrium-asset{id="${ASSET_B}" alt="not available"}`,
        ].join("\n")
      )
    ).rejects.toMatchObject<Partial<ValidationError>>({
      details: { unavailableAssetIds: [ASSET_B] },
    });
    expect(values).not.toHaveBeenCalled();
  });

  it("does no database work when the document references no assets", async () => {
    const { tx, select, values } = fakeTx([]);
    await pinVersionAssetsInTx(
      tx,
      OBJECT_ID,
      VERSION_ID,
      "# Plain document"
    );
    expect(select).not.toHaveBeenCalled();
    expect(values).not.toHaveBeenCalled();
  });
});
