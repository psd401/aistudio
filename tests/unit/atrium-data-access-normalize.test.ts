/**
 * `normalizeDataAccess` and the DTO mapper that uses it (#1725).
 *
 * `data_access` is the sandbox data-bridge pin (#1712): every surface that
 * enables the bridge forwards this value into `<ArtifactSandbox>`, which compares
 * it by EQUALITY against the operation the artifact asked for. A value outside
 * the enum therefore has to fail closed at the boundary rather than travel on as
 * an unrecognized string — otherwise it reads as "set" to any caller that only
 * checks for presence while matching no operation downstream.
 *
 * Before #1725 the reader page (`/c/[slug]`) normalized its own raw-row read
 * inline while `rowToObjectDTO` — the projection every OTHER surface reads,
 * including the two surfaces #1725 newly enables — used a bare cast. This pins
 * the single shared helper and its use in the mapper.
 */

import { normalizeDataAccess } from "@/lib/content/types";
import { rowToObjectDTO, type ObjectRowAsText } from "@/lib/content/mappers";

describe("normalizeDataAccess", () => {
  it.each(["records", "query", "none"] as const)(
    "passes the in-enum mode %s through unchanged",
    (mode) => {
      expect(normalizeDataAccess(mode)).toBe(mode);
    }
  );

  it.each([
    ["an unknown string", "everything"],
    ["the empty string", ""],
    ["a wrong-cased mode", "QUERY"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 1],
    ["an object", { mode: "query" }],
  ])("fails %s closed to none", (_label, value) => {
    expect(normalizeDataAccess(value)).toBe("none");
  });

  it("never returns a value outside the enum", () => {
    // Guards the shape of the contract itself: the sandbox pin compares by
    // equality, so the helper's range must be exactly the three modes.
    expect(["records", "query", "none"]).toContain(
      normalizeDataAccess("not-a-mode")
    );
  });
});

/** A minimal object row; only `dataAccess` matters to these assertions. */
function row(dataAccess: string): ObjectRowAsText {
  return {
    id: "obj-1",
    kind: "artifact",
    title: "Dashboard",
    slug: "dashboard",
    ownerUserId: 7,
    createdByActor: "human",
    createdByAgentId: null,
    collectionId: null,
    visibilityLevel: "private",
    currentVersionId: null,
    sourceRef: null,
    tags: [],
    coverGradient: null,
    icon: null,
    dataAccess,
    status: "draft",
    indexedAt: null,
    createdAt: null,
    updatedAt: null,
  } as ObjectRowAsText;
}

describe("rowToObjectDTO data-access normalization", () => {
  it("carries a valid mode through", () => {
    expect(rowToObjectDTO(row("query")).dataAccess).toBe("query");
  });

  it("fails an out-of-enum column value closed to none", () => {
    // A row predating migration 179 read through a widened column, or a DB enum
    // that drifted ahead of the TS union.
    expect(rowToObjectDTO(row("everything")).dataAccess).toBe("none");
  });
});
