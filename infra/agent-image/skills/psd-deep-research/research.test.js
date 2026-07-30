"use strict";

const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  DEFAULT_MAX_WAIT_MIN,
  ResearchCliError,
  runResearch,
} = require("./research");

describe("psd-deep-research CLI", () => {
  it("starts and immediately checks a completed interaction", async () => {
    const calls = [];
    const broker = async (_route, body, options) => {
      calls.push({ body, options });
      if (body.operation === "deep-research-start") {
        return { interactionId: "interaction-1", status: "in_progress" };
      }
      return {
        interactionId: "interaction-1",
        status: "completed",
        elapsedSec: 125,
        report: "Fixture-backed report",
        citations: [{ url: "https://example.org/source" }],
      };
    };

    await expectResearch(
      runResearch(
        {
          user: "owner@psd401.net",
          prompt: "Research a test topic",
        },
        { broker, now: () => 0 },
      ),
      {
        report: "Fixture-backed report",
        citations: [{ url: "https://example.org/source" }],
        interactionId: "interaction-1",
        durationMs: 125_000,
      },
    );
    assert.deepEqual(
      calls.map((call) => call.body.operation),
      ["deep-research-start", "deep-research-status"],
    );
    assert.equal(DEFAULT_MAX_WAIT_MIN, 20);
  });

  it("prints resumable timeout details without starting a replacement run", async () => {
    let clock = 0;
    const operations = [];
    const broker = async (_route, body) => {
      operations.push(body.operation);
      return body.operation === "deep-research-start"
        ? { interactionId: "interaction-timeout", status: "in_progress" }
        : {
            interactionId: "interaction-timeout",
            status: "in_progress",
            elapsedSec: Math.floor(clock / 1_000),
          };
    };

    await assert.rejects(
      runResearch(
        {
          user: "owner@psd401.net",
          prompt: "Slow research",
          max_wait_min: "0.001",
        },
        {
          broker,
          now: () => clock,
          sleep: async (milliseconds) => {
            clock += milliseconds;
          },
        },
      ),
      (error) => {
        assert.ok(error instanceof ResearchCliError);
        assert.equal(error.code, "timeout");
        assert.equal(error.interactionId, "interaction-timeout");
        assert.match(error.resumeCommand, /--check 'interaction-timeout'$/);
        return true;
      },
    );
    assert.equal(
      operations.filter((operation) => operation === "deep-research-start")
        .length,
      1,
    );
  });

  it("preserves resumable details when polling fails after a paid start", async () => {
    const operations = [];
    const broker = async (_route, body) => {
      operations.push(body.operation);
      if (body.operation === "deep-research-start") {
        return { interactionId: "interaction-recoverable", status: "in_progress" };
      }
      const error = new Error("Agent broker returned HTTP 502");
      error.responseBody = {
        code: "upstream_error",
        error: "Google status request failed",
      };
      throw error;
    };

    await assert.rejects(
      runResearch(
        {
          user: "owner@psd401.net",
          prompt: "Research with a transient poll failure",
        },
        { broker },
      ),
      (error) => {
        assert.ok(error instanceof ResearchCliError);
        assert.equal(error.code, "upstream_error");
        assert.equal(error.interactionId, "interaction-recoverable");
        assert.match(
          error.resumeCommand,
          /--check 'interaction-recoverable'$/,
        );
        return true;
      },
    );
    assert.deepEqual(operations, [
      "deep-research-start",
      "deep-research-status",
    ]);
  });

  it("--check performs exactly one status request", async () => {
    const calls = [];
    const result = await runResearch(
      {
        user: "owner@psd401.net",
        check: "interaction-active",
      },
      {
        broker: async (_route, body) => {
          calls.push(body);
          return {
            interactionId: "interaction-active",
            status: "in_progress",
            elapsedSec: 90,
          };
        },
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].operation, "deep-research-status");
    assert.equal(result.status, "in_progress");
    assert.match(result.resumeCommand, /--check 'interaction-active'$/);
  });
});

async function expectResearch(actual, expected) {
  assert.deepEqual(await actual, expected);
}
