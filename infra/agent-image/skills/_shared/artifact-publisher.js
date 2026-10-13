'use strict';

const { randomUUID } = require('node:crypto');
const { requestAgentBroker } = require('./agent-broker');
const { stageUploadedBytes } = require('./staged-upload');

/**
 * Publish bytes as an unsigned, PUBLIC-BY-LINK S3 object.
 *
 * Use this only for content that is genuinely meant to be public — a flyer, a
 * chart, a board packet. For anything with personal data in it, deliver the
 * file privately instead: `./drive-deliverer.js` puts it in the agent
 * account's Drive and shares it with the caller alone (#1885).
 *
 * The URL has no sign-in and no signature, and the object is deleted by the
 * `expire-public-artifacts` lifecycle rule 30 days after it is written.
 */
async function publishArtifact(bytes, extension, contentType) {
  if (!/^\.[a-z0-9]{1,8}$/.test(extension)) {
    throw new Error('Invalid artifact extension');
  }
  const reservationId = await stageUploadedBytes({
    operation: 'publish',
    path: `${randomUUID()}${extension}`,
    contentType,
    bytes,
  });
  const completed = await requestAgentBroker('/api/agent/workspace-storage', {
    operation: 'complete-upload',
    reservationId,
  });
  if (typeof completed.publicUrl !== 'string' || typeof completed.key !== 'string') {
    throw new TypeError('Artifact upload verification failed');
  }
  return { url: completed.publicUrl, key: completed.key };
}

module.exports = { publishArtifact };
