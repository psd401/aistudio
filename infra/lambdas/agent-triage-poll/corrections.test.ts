/**
 * detectCorrection must not mistake the classifier's own INBOX removal for
 * a user archive (PR #1856 review). `classifyAndLabel` removes INBOX on
 * every message it labels; Gmail reports that in the next tick's history.
 */
import { describe, expect, test } from "bun:test";
import { detectCorrection } from "./index";
import type { DecisionRecord, TriageRow } from "./types";

const IMPORTANT_LABEL = "Label_important";

function row(decision: Partial<DecisionRecord>): TriageRow {
  return {
    userEmail: "u@psd401.net",
    labelIdsByKey: { important: IMPORTANT_LABEL, later: "Label_later", news: "Label_news" },
    recentDecisions: [
      {
        messageId: "m1",
        threadId: "t1",
        label: "important",
        source: "llm",
        reason: "r",
        confidence: 0.9,
        ts: "2026-10-04T18:00:00Z",
        fromEmail: "a@psd401.net",
        subject: "s",
        shape: "approval",
        ...decision,
      },
    ],
  } as unknown as TriageRow;
}

const inboxRemoved = {
  message: { id: "m1", threadId: "t1" },
  labelIds: ["INBOX"],
};

describe("detectCorrection", () => {
  test("ignores the INBOX removal recorded by the classifier's own write", () => {
    const event = { id: "500", labelsRemoved: [inboxRemoved] };
    expect(
      detectCorrection(row({ labeledHistoryId: "500" }), inboxRemoved, "removed", event),
    ).toBeNull();
  });

  test("a later user archive still counts", () => {
    const event = { id: "612", labelsRemoved: [inboxRemoved] };
    expect(
      detectCorrection(row({ labeledHistoryId: "500" }), inboxRemoved, "removed", event),
    ).toMatchObject({ messageId: "m1", fromLabel: "important", toLabel: "archived", shape: "approval" });
  });

  test("without a recorded id, the same-record label add marks it as ours", () => {
    const event = {
      id: "500",
      labelsAdded: [{ message: { id: "m1", threadId: "t1" }, labelIds: [IMPORTANT_LABEL] }],
      labelsRemoved: [inboxRemoved],
    };
    expect(detectCorrection(row({}), inboxRemoved, "removed", event)).toBeNull();
  });

  test("without a recorded id, a bare INBOX removal is a user archive", () => {
    const event = { id: "612", labelsRemoved: [inboxRemoved] };
    expect(detectCorrection(row({}), inboxRemoved, "removed", event)).toMatchObject({
      toLabel: "archived",
    });
  });
});
