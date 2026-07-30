'use strict';

const status = Number(process.env.TEST_AGENT_BROKER_STATUS);
const body = process.env.TEST_AGENT_BROKER_BODY;

if (!Number.isInteger(status) || status < 100 || status > 599 || !body) {
  throw new Error('Missing or invalid agent-skills broker fixture configuration');
}

globalThis.fetch = async () =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
