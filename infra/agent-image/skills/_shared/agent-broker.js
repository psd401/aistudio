'use strict';

const { agentRequestHeaders } = require('./invocation-context');

const ALLOWED_ROUTES = new Set([
  '/api/agent/account-request',
  '/api/agent/aistudio',
  '/api/agent/atrium',
  '/api/agent/canva',
  '/api/agent/classified-evaluation',
  '/api/agent/consent-link',
  '/api/agent/credentials',
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
  const raw = process.env.APP_BASE_URL;
  if (!raw) throw new Error('APP_BASE_URL is not configured');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('APP_BASE_URL is invalid');
  }
  const localHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error('APP_BASE_URL must use HTTPS');
  }
  url.pathname = route;
  url.search = '';
  url.hash = '';
  return url;
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
    headers: agentRequestHeaders(),
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

async function getOwnerCredential(name, options = {}) {
  try {
    const body = await requestAgentBroker('/api/agent/credentials', {
      operation: 'get',
      name,
      sharedOnly: options.sharedOnly === true,
    });
    return body.credential || null;
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function putOwnerCredential(name, value) {
  const body = await requestAgentBroker('/api/agent/credentials', {
    operation: 'put',
    name,
    value,
  });
  return body.credential;
}

module.exports = {
  ALLOWED_ROUTES,
  brokerUrl,
  requestAgentBroker,
  getOwnerCredential,
  putOwnerCredential,
};
