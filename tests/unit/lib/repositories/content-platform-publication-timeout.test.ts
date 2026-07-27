/** @jest-environment node */

import { describe, expect, it, jest } from "@jest/globals";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  configureRepositoryPublicationTransaction,
  REPOSITORY_PUBLICATION_STATEMENT_TIMEOUT_MS,
  REPOSITORY_PUBLICATION_TRANSACTION_DEADLINE_MS,
} from "@/lib/repositories/content-platform/publication-service";

describe("repository publication timeout boundary", () => {
  it("extends only the current transaction below its caller deadline", async () => {
    const execute = jest.fn<(query: SQL) => Promise<unknown>>(
      async () => [],
    );

    await configureRepositoryPublicationTransaction({ execute });

    expect(execute).toHaveBeenCalledTimes(1);
    const compiled = new PgDialect().sqlToQuery(
      execute.mock.calls[0]![0],
    );
    expect(compiled.sql).toContain("set_config");
    expect(compiled.params).toEqual(["240000"]);
    expect(REPOSITORY_PUBLICATION_STATEMENT_TIMEOUT_MS).toBe(240_000);
    expect(REPOSITORY_PUBLICATION_TRANSACTION_DEADLINE_MS).toBe(270_000);
    expect(REPOSITORY_PUBLICATION_TRANSACTION_DEADLINE_MS).toBeGreaterThan(
      REPOSITORY_PUBLICATION_STATEMENT_TIMEOUT_MS,
    );
  });
});
