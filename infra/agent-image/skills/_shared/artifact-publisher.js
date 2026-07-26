'use strict';

const { randomUUID } = require('node:crypto');
const { requestAgentBroker } = require('./agent-broker');

async function publishArtifact(bytes, extension, contentType) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new Error('Artifact body must be bytes');
  }
  if (!/^\.[a-z0-9]{1,8}$/.test(extension)) {
    throw new Error('Invalid artifact extension');
  }
  const prepared = await requestAgentBroker('/api/agent/workspace-storage', {
    operation: 'publish',
    path: `${randomUUID()}${extension}`,
    contentType,
  });
  const response = await fetch(prepared.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: bytes,
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    throw new Error(`Artifact upload failed: HTTP ${response.status}`);
  }
  return { url: prepared.publicUrl, key: prepared.key };
}

module.exports = { publishArtifact };
