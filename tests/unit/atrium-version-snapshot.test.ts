/**
 * Unit tests for snapshotInTx body-format validation (Issue #1058, §14 / §6.1).
 *
 * Covers the pre-DB input guards in snapshotInTx:
 *  - empty / whitespace-only body  -> ValidationError
 *  - document with a non-markdown bodyFormat -> ValidationError
 *  - artifact with a markdown bodyFormat -> ValidationError
 *
 * These guards run BEFORE any DB IO, so the transaction stub throws if any of
 * its methods are reached — a guard regression that lets a bad body through to
 * the INSERT would surface as a different error (the stub's), failing the test.
 *
 * Heavy collaborators (drizzle schema, S3 store, the markdown renderer,
 * visibility service) are mocked so this stays a pure-logic unit test.
 */

// A factory that throws when called: any reach into the DB/IO layer before the
// pre-DB validation guards fire fails the test. Defined inline inside each mock
// factory because jest.mock() is hoisted above module-scope const declarations.
function makeTrap(name: string) {
  return () => {
    throw new Error(`snapshotInTx reached DB/IO (${name}) before validating input`);
  };
}

jest.mock("@/lib/db/drizzle-client", () => ({
  executeQuery: makeTrap("executeQuery"),
  executeTransaction: makeTrap("executeTransaction"),
}));
jest.mock("@/lib/db/schema", () => ({
  contentObjects: {},
  contentVersions: {},
}));
jest.mock("@/lib/db/drizzle-helpers", () => ({
  pgTimestampAsText: (c: unknown) => c,
}));
jest.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  desc: (a: unknown) => a,
  eq: (...a: unknown[]) => a,
  sql: Object.assign((..._a: unknown[]) => ({}), {}),
}));
jest.mock("@/lib/content/render/markdown-render", () => ({
  renderMarkdownToHtml: () => "<p>unused</p>",
}));
jest.mock("@/lib/content/storage/s3-store", () => ({
  s3Store: {
    key: () => "k",
    putText: () => {
      throw new Error("snapshotInTx reached S3 before validating input");
    },
  },
}));
jest.mock("@/lib/content/visibility-service", () => ({
  visibilityService: {},
}));

import { snapshotInTx } from "@/lib/content/version-service";
import { ValidationError } from "@/lib/content/errors";
import type { DbTransaction } from "@/lib/db/drizzle-client";
import type { Requester } from "@/lib/content/types";

// A transaction stub that throws if any query method is invoked: the validation
// guards must reject before any DB access.
const tx = new Proxy(
  {},
  {
    get() {
      throw new Error("snapshotInTx accessed the transaction before validating");
    },
  }
) as unknown as DbTransaction;

const req: Requester = {
  kind: "user",
  userId: 1,
  roles: ["staff"],
  isAdmin: false,
};

const doc = { id: "o1", kind: "document" as const };
const art = { id: "o2", kind: "artifact" as const };

describe("snapshotInTx body-format validation", () => {
  it("rejects an empty body", async () => {
    await expect(snapshotInTx(tx, req, doc, { body: "" })).rejects.toThrow(
      ValidationError
    );
  });

  it("rejects a whitespace-only body", async () => {
    await expect(
      snapshotInTx(tx, req, doc, { body: "   \n\t " })
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a document with a non-markdown bodyFormat", async () => {
    await expect(
      snapshotInTx(tx, req, doc, { body: "<h1>hi</h1>", bodyFormat: "html" })
    ).rejects.toThrow(/Documents must use bodyFormat 'markdown'/);
  });

  it("rejects an artifact with a markdown bodyFormat", async () => {
    await expect(
      snapshotInTx(tx, req, art, { body: "# code", bodyFormat: "markdown" })
    ).rejects.toThrow(/Artifacts must use bodyFormat 'html' or 'jsx'/);
  });
});
