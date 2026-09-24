/**
 * @jest-environment node
 *
 * Issue #1791 finding 7: workspace source payloads accumulate in the history
 * and are re-sent on every turn. These tests pin the two properties that make
 * pruning safe to do at all:
 *
 *   1. the NEWEST payload survives verbatim, and
 *   2. the part SHAPE is preserved exactly, so `convertToModelMessages` still
 *      emits a `tool_result` for every `tool_call` (a dropped result is what
 *      raises `AI_MissingToolResultsError` on replay).
 */

import { describe, it, expect } from "@jest/globals";
import type { UIMessage } from "ai";
import {
  pruneStaleWorkspaceToolPayloads,
  WORKSPACE_SOURCE_TOOLS,
} from "../workspace-tool-history";

const bigCode = (marker: string) => `<!doctype html>${marker.repeat(5_000)}`;

function updatePart(callId: string, code: string): Record<string, unknown> {
  return {
    type: "tool-update_workspace_artifact",
    toolCallId: callId,
    state: "output-available",
    input: { code, dataAccess: "query" },
    output: { success: true, versionNumber: 3 },
  };
}

function readPart(callId: string, body: string): Record<string, unknown> {
  return {
    type: "tool-read_workspace_content",
    toolCallId: callId,
    state: "output-available",
    input: {},
    output: { title: "Repairs dashboard", dataAccess: "query", body },
  };
}

function message(id: string, parts: unknown[]): UIMessage {
  return {
    id,
    role: "assistant",
    parts: parts as UIMessage["parts"],
  } as UIMessage;
}

describe("pruneStaleWorkspaceToolPayloads", () => {
  it("leaves a history with no workspace tool parts untouched (by reference)", () => {
    const messages = [
      message("m1", [{ type: "text", text: "hello" }]),
    ];
    expect(pruneStaleWorkspaceToolPayloads(messages)).toBe(messages);
  });

  it("leaves a single workspace payload verbatim", () => {
    const code = bigCode("a");
    const messages = [message("m1", [updatePart("c1", code)])];
    const out = pruneStaleWorkspaceToolPayloads(messages);
    expect(out).toBe(messages);
    expect(
      (out[0].parts[0] as unknown as Record<string, Record<string, unknown>>)
        .input.code
    ).toBe(code);
  });

  it("stubs superseded sources and keeps only the newest verbatim", () => {
    const first = bigCode("a");
    const second = bigCode("b");
    const newest = bigCode("c");
    const messages = [
      message("m1", [updatePart("c1", first)]),
      message("m2", [readPart("c2", second)]),
      message("m3", [updatePart("c3", newest)]),
    ];

    const out = pruneStaleWorkspaceToolPayloads(messages);
    const input = (index: number) =>
      (out[index].parts[0] as unknown as Record<string, Record<string, unknown>>)
        .input;
    const output = (index: number) =>
      (out[index].parts[0] as unknown as Record<string, Record<string, unknown>>)
        .output;

    expect(input(0).code).not.toBe(first);
    expect(String(input(0).code)).toContain("omitted from history");
    expect(String(input(0).code)).toContain("read_workspace_content");
    expect(String(output(1).body)).toContain("omitted from history");

    // The newest payload is the one the model is most likely to still need.
    expect(input(2).code).toBe(newest);
  });

  it("preserves part shape so every tool call keeps its result", () => {
    const messages = [
      message("m1", [updatePart("c1", bigCode("a"))]),
      message("m2", [updatePart("c2", bigCode("b"))]),
    ];
    const out = pruneStaleWorkspaceToolPayloads(messages);
    const part = out[0].parts[0] as unknown as Record<string, unknown>;

    expect(part.type).toBe("tool-update_workspace_artifact");
    expect(part.toolCallId).toBe("c1");
    expect(part.state).toBe("output-available");
    expect(Object.keys(part.input as object).sort()).toEqual([
      "code",
      "dataAccess",
    ]);
    expect(part.output).toEqual({ success: true, versionNumber: 3 });
  });

  it("keeps short fields — the meaning in the history — fully intact", () => {
    const messages = [
      message("m1", [updatePart("c1", bigCode("a"))]),
      message("m2", [updatePart("c2", bigCode("b"))]),
    ];
    const out = pruneStaleWorkspaceToolPayloads(messages);
    const input = (out[0].parts[0] as unknown as Record<string, Record<string, unknown>>)
      .input;
    // `dataAccess` is what a "switch to live data" follow-up depends on.
    expect(input.dataAccess).toBe("query");
  });

  it("does not touch non-workspace tool parts", () => {
    const otherPayload = bigCode("z");
    const messages = [
      message("m1", [
        {
          type: "tool-searchNexusAttachments",
          toolCallId: "x1",
          state: "output-available",
          input: {},
          output: { text: otherPayload },
        },
      ]),
      message("m2", [updatePart("c1", bigCode("a"))]),
      message("m3", [updatePart("c2", bigCode("b"))]),
    ];
    const out = pruneStaleWorkspaceToolPayloads(messages);
    expect(
      (out[0].parts[0] as unknown as Record<string, Record<string, unknown>>)
        .output.text
    ).toBe(otherPayload);
  });

  it("handles the persisted args/result representation too", () => {
    const messages = [
      message("m1", [
        {
          type: "tool-call",
          toolName: "update_workspace_artifact",
          toolCallId: "c1",
          args: { code: bigCode("a") },
          result: { success: true },
        },
      ]),
      message("m2", [updatePart("c2", bigCode("b"))]),
    ];
    const out = pruneStaleWorkspaceToolPayloads(messages);
    const part = out[0].parts[0] as unknown as Record<
      string,
      Record<string, unknown>
    >;
    expect(String(part.args.code)).toContain("omitted from history");
    expect(part.result).toEqual({ success: true });
  });

  it("tolerates messages without a parts array", () => {
    const messages = [
      { id: "m1", role: "user" } as unknown as UIMessage,
      message("m2", [updatePart("c1", bigCode("a"))]),
      message("m3", [updatePart("c2", bigCode("b"))]),
    ];
    expect(() => pruneStaleWorkspaceToolPayloads(messages)).not.toThrow();
  });

  it("covers every source-carrying workspace tool", () => {
    expect([...WORKSPACE_SOURCE_TOOLS].sort()).toEqual([
      "edit_atrium_document",
      "edit_workspace_document",
      "read_workspace_content",
      "update_workspace_artifact",
    ]);
  });

  it("never stubs another object's source as superseded (rebound conversation)", () => {
    const artifactA = bigCode("a");
    const artifactB1 = bigCode("b");
    const artifactB2 = bigCode("c");
    const withId = (part: Record<string, unknown>, objectId: string) => ({
      ...part,
      output: { ...(part.output as Record<string, unknown>), objectId },
    });
    const messages = [
      message("m1", [withId(updatePart("c1", artifactA), "obj-a")]),
      message("m2", [withId(updatePart("c2", artifactB1), "obj-b")]),
      message("m3", [withId(updatePart("c3", artifactB2), "obj-b")]),
    ];

    const out = pruneStaleWorkspaceToolPayloads(messages);
    const code = (i: number) =>
      (out[i].parts[0] as unknown as Record<string, Record<string, unknown>>)
        .input.code;
    // A has no later copy of itself: it stays verbatim.
    expect(code(0)).toBe(artifactA);
    // B's earlier revision IS superseded by B's newer one.
    expect(code(1)).toMatch(/^\[omitted from history/);
    expect(code(2)).toBe(artifactB2);
  });
});

describe("pruneStaleWorkspaceToolPayloads — paged reads of one revision", () => {
  const page = (callId: string, offset: number, body: string) => ({
    ...readPart(callId, body),
    output: { objectId: "obj-a", title: "Big", body, byteOffset: offset },
  });
  const write = (callId: string, code: string) => ({
    ...updatePart(callId, code),
    output: { success: true, objectId: "obj-a" },
  });
  const text = (out: UIMessage[], i: number) => {
    const part = out[i].parts[0] as unknown as Record<string, Record<string, unknown>>;
    return (part.output.body ?? part.input.code) as string;
  };

  it("keeps EVERY page of the current revision, not just the last one", () => {
    const p0 = bigCode("a");
    const p1 = bigCode("b");
    const p2 = bigCode("c");
    const out = pruneStaleWorkspaceToolPayloads([
      message("m1", [page("r0", 0, p0)]),
      message("m2", [page("r1", 98_304, p1)]),
      message("m3", [page("r2", 196_608, p2)]),
    ]);
    expect(text(out, 0)).toBe(p0);
    expect(text(out, 1)).toBe(p1);
    expect(text(out, 2)).toBe(p2);
  });

  it("stubs pages read BEFORE the newest write — they are the old revision", () => {
    const oldPage = bigCode("a");
    const newCode = bigCode("b");
    const freshPage = bigCode("c");
    const out = pruneStaleWorkspaceToolPayloads([
      message("m1", [page("r0", 0, oldPage)]),
      message("m2", [write("w1", newCode)]),
      message("m3", [page("r1", 0, freshPage)]),
    ]);
    expect(text(out, 0)).toMatch(/^\[omitted from history/);
    expect(text(out, 1)).toBe(newCode);
    expect(text(out, 2)).toBe(freshPage);
  });

  it("stubs an older re-read of the SAME page", () => {
    const first = bigCode("a");
    const again = bigCode("b");
    const out = pruneStaleWorkspaceToolPayloads([
      message("m1", [page("r0", 0, first)]),
      message("m2", [page("r1", 0, again)]),
    ]);
    expect(text(out, 0)).toMatch(/^\[omitted from history/);
    expect(text(out, 1)).toBe(again);
  });

  it("a mode-only update does not supersede the read pages (the source did not change)", () => {
    const p0 = bigCode("a");
    const p1 = bigCode("b");
    const modeOnly = {
      type: "tool-update_workspace_artifact",
      toolCallId: "w1",
      state: "output-available",
      input: { code: null, dataAccess: "query" },
      output: { ok: true, objectId: "obj-a", dataAccess: "query" },
    };
    const out = pruneStaleWorkspaceToolPayloads([
      message("m1", [page("r0", 0, p0)]),
      message("m2", [page("r1", 98_304, p1)]),
      message("m3", [modeOnly]),
    ]);
    expect(text(out, 0)).toBe(p0);
    expect(text(out, 1)).toBe(p1);
  });

  it("never stitches an older read sequence's tail onto a fresh first page", () => {
    // Read in pages, then the source changed OUTSIDE the chat (Code tab) and
    // the model started over at offset 0: the old tail is a different revision.
    const oldHead = bigCode("a");
    const oldTail = bigCode("b");
    const newHead = bigCode("c");
    const out = pruneStaleWorkspaceToolPayloads([
      message("m1", [page("r0", 0, oldHead)]),
      message("m2", [page("r1", 98_304, oldTail)]),
      message("m3", [page("r2", 0, newHead)]),
    ]);
    expect(text(out, 0)).toMatch(/^\[omitted from history/);
    expect(text(out, 1)).toMatch(/^\[omitted from history/);
    expect(text(out, 2)).toBe(newHead);
  });
});

