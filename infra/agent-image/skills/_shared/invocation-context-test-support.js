"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TEST_TOKEN = `v1.${"a".repeat(40)}.${"b".repeat(43)}`;
const TEST_CONTEXT_PATH = path.join(
  os.tmpdir(),
  `psd-agent-invocation-context-test-${process.pid}`,
);

function installTestInvocationContext() {
  fs.writeFileSync(TEST_CONTEXT_PATH, `${TEST_TOKEN}\n`, "ascii");
  process.env.PSD_INVOCATION_CONTEXT_FILE = TEST_CONTEXT_PATH;
  return TEST_TOKEN;
}

module.exports = {
  TEST_CONTEXT_PATH,
  TEST_TOKEN,
  installTestInvocationContext,
};
