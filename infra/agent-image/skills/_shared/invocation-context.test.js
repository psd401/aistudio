const { afterEach, describe, expect, test } = require("bun:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  agentRequestHeaders,
  internalAgentRequestHeaders,
  invocationContextHeaders,
  readInvocationContextToken,
} = require("./invocation-context");

const temporaryFiles = [];

function contextFile(value) {
  const file = path.join(os.tmpdir(), `psd-invocation-${crypto.randomUUID()}`);
  fs.writeFileSync(file, value, "ascii");
  temporaryFiles.push(file);
  process.env.PSD_INVOCATION_CONTEXT_FILE = file;
}

afterEach(() => {
  delete process.env.PSD_INVOCATION_CONTEXT_FILE;
  for (const file of temporaryFiles.splice(0)) {
    fs.rmSync(file, { force: true });
  }
});

describe("invocation context helper", () => {
  test("returns an opaque well-formed token as an HTTP header", () => {
    const token = `v1.${"a".repeat(40)}.${"b".repeat(43)}`;
    contextFile(`${token}\n`);
    expect(readInvocationContextToken()).toBe(token);
    expect(invocationContextHeaders()).toEqual({
      "X-Agent-Invocation-Context": token,
    });
    expect(agentRequestHeaders()).toEqual({
      "Content-Type": "application/json",
      "X-Agent-Invocation-Context": token,
    });
    expect(internalAgentRequestHeaders("transport-key")).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer transport-key",
      "X-Agent-Invocation-Context": token,
    });
  });

  test("fails closed for missing or malformed context", () => {
    process.env.PSD_INVOCATION_CONTEXT_FILE = "/definitely/missing";
    expect(() => readInvocationContextToken()).toThrow("unavailable");
    contextFile("not-signed");
    expect(() => invocationContextHeaders()).toThrow("malformed");
    expect(() => internalAgentRequestHeaders("")).toThrow("API key");
  });
});
