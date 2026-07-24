/** Transactional version-to-ready-asset pinning (#1284). */

import { and, eq, inArray } from "drizzle-orm";
import type { DbTransaction } from "@/lib/db/drizzle-client";
import { contentAssets, contentVersionAssets } from "@/lib/db/schema";
import { parseContentAssetIds } from "./asset-directive";
import { ValidationError } from "./errors";

export async function pinVersionAssetsInTx(
  tx: DbTransaction,
  objectId: string,
  versionId: string,
  markdown: string
): Promise<void> {
  const assetIds = parseContentAssetIds(markdown);
  if (assetIds.length === 0) return;
  const ready = await tx
    .select({ id: contentAssets.id })
    .from(contentAssets)
    .where(
      and(
        eq(contentAssets.objectId, objectId),
        eq(contentAssets.state, "ready"),
        inArray(contentAssets.id, assetIds)
      )
    );
  const readyIds = new Set(ready.map((row) => row.id));
  const unavailable = assetIds.filter((id) => !readyIds.has(id));
  if (unavailable.length > 0) {
    throw new ValidationError(
      "Every authored asset reference must belong to this object and be ready",
      {
        unavailableAssetIds: unavailable,
      }
    );
  }
  await tx.insert(contentVersionAssets).values(
    assetIds.map((assetId) => ({
      versionId,
      assetId,
    }))
  );
}
