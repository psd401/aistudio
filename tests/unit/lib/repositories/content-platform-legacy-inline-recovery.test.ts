/** @jest-environment node */

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: jest.fn(),
  executeTransaction: jest.fn(),
  toPgRows: (rows: unknown) => rows,
}));

import { executeTransaction } from "@/lib/db/drizzle-client";
import { claimLegacyInlineTextRecoveries } from "@/lib/repositories/content-platform/legacy-inline-recovery";

const mockExecuteTransaction = executeTransaction as jest.Mock;

describe("legacy inline source recovery leases", () => {
  it("requires a non-empty per-invocation lease owner", async () => {
    await expect(
      claimLegacyInlineTextRecoveries({ leaseOwner: "   " })
    ).rejects.toThrow("requires a unique lease owner");
    expect(mockExecuteTransaction).not.toHaveBeenCalled();
  });

  it("binds the caller's unique owner into the atomic claim", async () => {
    let claimQuery: SQL | undefined;
    mockExecuteTransaction.mockImplementationOnce(
      async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          execute: async (query: SQL) => {
            claimQuery = query;
            return [];
          },
        })
    );

    await expect(
      claimLegacyInlineTextRecoveries({
        leaseOwner: "legacy-inline-source-recovery:request-123",
        now: new Date("2026-07-22T12:00:00.000Z"),
      })
    ).resolves.toEqual([]);

    expect(claimQuery).toBeDefined();
    const rendered = new PgDialect().sqlToQuery(claimQuery as SQL);
    expect(rendered.params).toContain(
      "legacy-inline-source-recovery:request-123"
    );
    expect(rendered.sql).toContain("lease_owner =");
    expect(rendered.sql).toContain("FOR UPDATE OF job SKIP LOCKED");
  });
});
