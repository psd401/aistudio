/**
 * Tests for the agent-reply parser. The actual AgentCore invocation is
 * integration territory; this just locks the parser's tolerance for the
 * various shapes Bedrock + agent skill can return.
 */
import { describe, expect, test } from "bun:test";
import { parseAgentReply } from "./agentcore";

describe("parseAgentReply", () => {
  test("success — life-os issue", () => {
    const r = parseAgentReply("Created life-os issue #1234: Review the new policy draft");
    expect(r).toMatchObject({ ok: true, taskRef: "#1234" });
  });

  test("success — google tasks", () => {
    const r = parseAgentReply("Created google-tasks task abc-xyz-123: Reply to legal");
    expect(r).toMatchObject({ ok: true, taskRef: "abc-xyz-123" });
  });

  test("failure", () => {
    const r = parseAgentReply("FAILED: gh CLI not authenticated");
    expect(r).toMatchObject({ ok: false, reason: "gh CLI not authenticated" });
  });

  test("AgentCore JSON envelope wrapping", () => {
    const r = parseAgentReply(
      JSON.stringify({ result: "Created life-os issue #42: Schedule one-on-one" }),
    );
    expect(r).toMatchObject({ ok: true, taskRef: "#42" });
  });

  test("AgentCore JSON envelope with `message` key", () => {
    const r = parseAgentReply(
      JSON.stringify({ message: "FAILED: rate-limited by github" }),
    );
    expect(r).toMatchObject({ ok: false, reason: "rate-limited by github" });
  });

  test("multi-line reply — picks the first matching line", () => {
    const r = parseAgentReply(
      "OK, working on it.\nCreated life-os issue #99: x\nDone.",
    );
    expect(r).toMatchObject({ ok: true, taskRef: "#99" });
  });

  test("empty reply", () => {
    expect(parseAgentReply("")).toMatchObject({ ok: false, reason: "empty agent reply" });
  });

  test("unparseable reply", () => {
    const r = parseAgentReply("I think I handled it. Should be in your queue now.");
    expect(r).toMatchObject({ ok: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("unparseable");
    }
  });

  test("FAILED line takes precedence over later Created line", () => {
    const r = parseAgentReply("FAILED: github 503\nCreated life-os issue #1: stub");
    expect(r).toMatchObject({ ok: false, reason: "github 503" });
  });

  test("AgentCore SSE stream — success in last data event", () => {
    const sse = [
      `data: {"type": "start", "session_id": "x-y-z"}`,
      ``,
      `data: {"type": "heartbeat", "elapsed_s": 30}`,
      ``,
      `data: {"result": "Created life-os issue #777: Reply to legal"}`,
      ``,
    ].join("\n");
    expect(parseAgentReply(sse)).toMatchObject({ ok: true, taskRef: "#777" });
  });

  test("AgentCore SSE stream — failure in last data event", () => {
    const sse = [
      `data: {"type": "start"}`,
      ``,
      `data: {"result": "FAILED: gh CLI not authenticated"}`,
      ``,
    ].join("\n");
    expect(parseAgentReply(sse)).toMatchObject({
      ok: false,
      reason: "gh CLI not authenticated",
    });
  });

  test("AgentCore SSE stream — conversational reply with no pattern", () => {
    // This is the actual 2026-05-22 bug — agent replied with prose
    // because the MEMORY.md snippet wasn't in place. Parser should
    // surface the prose as the failure reason rather than choking.
    const sse = [
      `data: {"type": "start", "session_id": "hagelk-task-19e154b19e1d6951-1779483775544"}`,
      ``,
      `data: {"type": "heartbeat", "elapsed_s": 30}`,
      ``,
      `data: {"result": "I need to check my task management capabilities and figure out where to put this."}`,
      ``,
    ].join("\n");
    const r = parseAgentReply(sse);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("unparseable");
      expect(r.reason).toContain("I need to check");
    }
  });
});
