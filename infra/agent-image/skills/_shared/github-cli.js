#!/usr/bin/env node
'use strict';

const { requestAgentBroker } = require('./agent-broker');

async function main() {
  const result = await requestAgentBroker('/api/agent/github-execute', {
    argv: process.argv.slice(2),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

main().catch((error) => {
  process.stderr.write(`gh-broker: ${error.message}\n`);
  process.exit(error.status === 400 ? 2 : 1);
});
