/**
 * The preview-failure ring buffer and the shared bridge error contract (#1787).
 *
 * This buffer is the ONLY path by which a chat model learns that the artifact it
 * just wrote does not work — the preview runs cross-origin in the user's browser
 * and the model sees nothing but tool results. So the properties that matter are
 * the ones that decide whether the model is told the truth: it must never report
 * one artifact's failures against another, never grow without bound, and never
 * carry multi-line text into a prompt.
 */

import {
  ARTIFACT_BRIDGE_ERROR_CODES,
  ARTIFACT_BRIDGE_ERROR_MESSAGES,
  MAX_ARTIFACT_BRIDGE_ERROR_MESSAGE_LENGTH,
  artifactBridgeErrorMessage,
  boundBridgeErrorMessage,
  isArtifactBridgeErrorCode,
} from "@/lib/content/artifact-bridge-errors";
import {
  MAX_PREVIEW_DIAGNOSTICS,
  MAX_PREVIEW_DIAGNOSTIC_SQL_LENGTH,
  clearArtifactPreviewDiagnostics,
  readArtifactPreviewDiagnostics,
  recordArtifactPreviewDiagnostic,
  restoreTakenArtifactPreviewDiagnostics,
  takeArtifactPreviewDiagnostics,
} from "@/lib/atrium/artifact-preview-diagnostics";

beforeEach(() => {
  clearArtifactPreviewDiagnostics();
});

describe("artifact bridge error contract", () => {
  it("has a message for every code", () => {
    for (const code of ARTIFACT_BRIDGE_ERROR_CODES) {
      expect(ARTIFACT_BRIDGE_ERROR_MESSAGES[code]).toBeTruthy();
      expect(artifactBridgeErrorMessage(code)).toBe(
        ARTIFACT_BRIDGE_ERROR_MESSAGES[code]
      );
    }
  });

  it("narrows only the known codes and falls back to unavailable", () => {
    expect(isArtifactBridgeErrorCode("query_error")).toBe(true);
    expect(isArtifactBridgeErrorCode("QUERY_ERROR")).toBe(false);
    expect(isArtifactBridgeErrorCode(undefined)).toBe(false);
    expect(artifactBridgeErrorMessage("something_new")).toBe(
      ARTIFACT_BRIDGE_ERROR_MESSAGES.unavailable
    );
  });

  it("flattens a multi-line upstream message to one line", () => {
    // A Postgres error is multi-line; newlines inside a model prompt read as
    // injected structure, and inside a log line they break the record.
    expect(
      boundBridgeErrorMessage('syntax error at or near "SELEC"\nLINE 1: SELEC\n        ^')
    ).toBe('syntax error at or near "SELEC" LINE 1: SELEC ^');
  });

  it("returns null for empty / non-string input so callers can fall back", () => {
    expect(boundBridgeErrorMessage("   \n  ")).toBeNull();
    expect(boundBridgeErrorMessage(undefined)).toBeNull();
    expect(boundBridgeErrorMessage(42)).toBeNull();
  });

  it("bounds a pathological message", () => {
    const bounded = boundBridgeErrorMessage("x".repeat(10_000));
    expect(bounded).toHaveLength(MAX_ARTIFACT_BRIDGE_ERROR_MESSAGE_LENGTH);
    expect(bounded?.endsWith("…")).toBe(true);
  });
});

describe("artifact preview diagnostics buffer", () => {
  it("records and reads back a failure for one artifact", () => {
    recordArtifactPreviewDiagnostic("art-1", {
      kind: "data",
      code: "query_error",
      message: 'column "school_name" does not exist',
      sql: "SELECT school_name FROM devices",
    });

    expect(readArtifactPreviewDiagnostics()).toEqual({
      contentId: "art-1",
      entries: [
        {
          kind: "data",
          code: "query_error",
          message: 'column "school_name" does not exist',
          sql: "SELECT school_name FROM devices",
          at: expect.any(Number),
        },
      ],
    });
  });

  it("returns null when nothing has failed", () => {
    expect(readArtifactPreviewDiagnostics()).toBeNull();
  });

  it("drops an unrecognized code rather than passing it through", () => {
    recordArtifactPreviewDiagnostic("art-1", {
      kind: "data",
      code: "made_up" as never,
      message: "boom",
    });

    const buffer = readArtifactPreviewDiagnostics();
    expect(buffer?.entries[0]).not.toHaveProperty("code");
  });

  it("ignores an entry whose message normalizes to nothing", () => {
    recordArtifactPreviewDiagnostic("art-1", { kind: "script", message: "  \n " });
    expect(readArtifactPreviewDiagnostics()).toBeNull();
  });

  it("evicts the oldest entries past the cap", () => {
    for (let i = 0; i < MAX_PREVIEW_DIAGNOSTICS + 5; i += 1) {
      recordArtifactPreviewDiagnostic("art-1", {
        kind: "script",
        message: `error ${i}`,
      });
    }

    const buffer = readArtifactPreviewDiagnostics();
    expect(buffer?.entries).toHaveLength(MAX_PREVIEW_DIAGNOSTICS);
    expect(buffer?.entries[0]?.message).toBe("error 5");
    expect(buffer?.entries.at(-1)?.message).toBe(
      `error ${MAX_PREVIEW_DIAGNOSTICS + 4}`
    );
  });

  it("truncates the SQL prefix — it identifies the query, it is not the query", () => {
    recordArtifactPreviewDiagnostic("art-1", {
      kind: "data",
      code: "query_error",
      message: "bad",
      sql: "S".repeat(5_000),
    });

    expect(readArtifactPreviewDiagnostics()?.entries[0]?.sql).toHaveLength(
      MAX_PREVIEW_DIAGNOSTIC_SQL_LENGTH
    );
  });

  it("REPLACES the buffer when a different artifact starts reporting", () => {
    // The failure this prevents: artifact A's broken SQL being reported to the
    // chat as artifact B's, sending the model to fix code that is already fine.
    recordArtifactPreviewDiagnostic("art-1", { kind: "script", message: "from A" });
    recordArtifactPreviewDiagnostic("art-2", { kind: "script", message: "from B" });

    expect(readArtifactPreviewDiagnostics()).toEqual({
      contentId: "art-2",
      entries: [{ kind: "script", message: "from B", at: expect.any(Number) }],
    });
  });

  it("returns a copy, so a later record cannot mutate an in-flight payload", () => {
    recordArtifactPreviewDiagnostic("art-1", { kind: "script", message: "first" });
    const snapshot = readArtifactPreviewDiagnostics();
    recordArtifactPreviewDiagnostic("art-1", { kind: "script", message: "second" });

    expect(snapshot?.entries).toHaveLength(1);
    expect(readArtifactPreviewDiagnostics()?.entries).toHaveLength(2);
  });

  it("clears on demand, so a new version does not inherit the old one's failures", () => {
    recordArtifactPreviewDiagnostic("art-1", { kind: "script", message: "stale" });
    clearArtifactPreviewDiagnostics();
    expect(readArtifactPreviewDiagnostics()).toBeNull();
  });

  it("TAKE empties the buffer, so a failure reaches the chat exactly once", () => {
    recordArtifactPreviewDiagnostic("art-1", { kind: "script", message: "boom" });

    expect(takeArtifactPreviewDiagnostics()?.entries).toHaveLength(1);
    expect(takeArtifactPreviewDiagnostics()).toBeNull();

    // A failure the preview hits AGAIN after the send is reported again.
    recordArtifactPreviewDiagnostic("art-1", { kind: "script", message: "boom" });
    expect(takeArtifactPreviewDiagnostics()?.entries).toHaveLength(1);
  });

  it("RESTORES taken entries when the send that carried them failed", () => {
    recordArtifactPreviewDiagnostic("art-1", { kind: "script", message: "old" });
    takeArtifactPreviewDiagnostics();
    // Recorded after the take, while the failed request was in flight.
    recordArtifactPreviewDiagnostic("art-1", { kind: "script", message: "new" });

    restoreTakenArtifactPreviewDiagnostics();

    expect(
      readArtifactPreviewDiagnostics()?.entries.map((entry) => entry.message)
    ).toEqual(["old", "new"]);
  });

  it("restores only once", () => {
    recordArtifactPreviewDiagnostic("art-1", { kind: "script", message: "boom" });
    takeArtifactPreviewDiagnostics();

    restoreTakenArtifactPreviewDiagnostics();
    restoreTakenArtifactPreviewDiagnostics();

    expect(readArtifactPreviewDiagnostics()?.entries).toHaveLength(1);
  });

  it("does NOT restore once a new version cleared the buffer", () => {
    recordArtifactPreviewDiagnostic("art-1", { kind: "script", message: "stale" });
    takeArtifactPreviewDiagnostics();
    clearArtifactPreviewDiagnostics();

    restoreTakenArtifactPreviewDiagnostics();

    expect(readArtifactPreviewDiagnostics()).toBeNull();
  });

  it("does NOT restore over a different artifact's failures", () => {
    recordArtifactPreviewDiagnostic("art-1", { kind: "script", message: "from A" });
    takeArtifactPreviewDiagnostics();
    recordArtifactPreviewDiagnostic("art-2", { kind: "script", message: "from B" });

    restoreTakenArtifactPreviewDiagnostics();

    expect(readArtifactPreviewDiagnostics()).toEqual({
      contentId: "art-2",
      entries: [{ kind: "script", message: "from B", at: expect.any(Number) }],
    });
  });
});
