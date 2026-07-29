'use strict';

const ALLOWED_ROUTES = new Set([
  '/api/agent/account-request',
  '/api/agent/aistudio',
  '/api/agent/atrium',
  '/api/agent/canva',
  '/api/agent/classified-evaluation',
  '/api/agent/workflow-gateway',
  '/api/agent/consent-link',
  '/api/agent/credentials',
  '/api/agent/directory-lookup',
  '/api/agent/email-triage',
  '/api/agent/failures',
  '/api/agent/github-execute',
  '/api/agent/schedules',
  '/api/agent/skills',
  '/api/agent/workspace-execute',
  '/api/agent/workspace-storage',
]);

function brokerUrl(route) {
  if (!ALLOWED_ROUTES.has(route)) {
    throw new Error('Unsupported agent broker route');
  }
  return new URL(`http://127.0.0.1:18791/agent-broker${route}`);
}

async function requestAgentBroker(route, payload, options = {}) {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0 &&
    options.timeoutMs <= 920_000
      ? options.timeoutMs
      : 15_000;
  const response = await fetch(brokerUrl(route), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Agent broker returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    const reason =
      body && typeof body.error === 'string'
        ? body.error
        : `HTTP ${response.status}`;
    const error = new Error(`Agent broker rejected the request: ${reason}`);
    error.status = response.status;
    error.responseBody = body;
    throw error;
  }
  return body;
}

module.exports = {
  ALLOWED_ROUTES,
  brokerUrl,
  requestAgentBroker,
};
