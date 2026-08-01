/** @jest-environment node */

import { DbPoolDeadlineError } from "@/lib/db/pool-guard";
import {
  isRepositoryPublicationContention,
  RepositoryPublicationContentionError,
} from "@/lib/repositories/content-platform/publication-contention";

describe("repository publication contention", () => {
  it("recognizes PostgreSQL lock codes through a wrapped Drizzle error", () => {
    const postgresError = Object.assign(new Error("lock unavailable"), {
      code: "55P03",
    });
    const drizzleError = new Error("Failed query: select ... for update", {
      cause: postgresError,
    });

    expect(isRepositoryPublicationContention(drizzleError)).toBe(true);
  });

  it.each([
    "canceling statement due to lock timeout",
    "could not obtain lock on row in relation",
    "deadlock detected",
  ])("recognizes PostgreSQL contention message %s", (message) => {
    expect(isRepositoryPublicationContention(new Error(message))).toBe(true);
  });

  it("recognizes the typed publication error", () => {
    expect(
      isRepositoryPublicationContention(
        new RepositoryPublicationContentionError(new Error("locked"))
      )
    ).toBe(true);
  });

  it("does not misclassify a database pool deadline", () => {
    expect(
      isRepositoryPublicationContention(
        new DbPoolDeadlineError("publishDocumentVersion", 270_000)
      )
    ).toBe(false);
  });
});
