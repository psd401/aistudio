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
  // Read as text and check `response.ok` BEFORE blaming the JSON.
  //
  // This previously called response.json() first, so any error response with a
  // non-JSON body (a proxy/WAF HTML page, an empty 403) surfaced as
  // "Agent broker returned invalid JSON (HTTP 403)" and the real reason was
  // discarded. That is the anti-pattern called out in CLAUDE.md, and it cost us
  // real diagnosis: on 2026-08-04 an agent hit a masked 403 on
  // docs.documents.batchUpdate, concluded that straight double-quote characters
  // break the payload, and adopted a curly-quote "workaround" for a cause that
  // was never established.
  const raw = await response.text();
  let body = null;
  let parseFailed = false;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    parseFailed = true;
  }

  if (!response.ok) {
    // Reason precedence, tightest first:
    //   1. the broker's own `error` string — structured and safe to surface;
    //   2. a snippet, but ONLY when the body did not parse as JSON. A
    //      non-JSON body is a proxy/WAF page, which is exactly the case that
    //      used to be swallowed. A body that DID parse is one of our own
    //      structured responses and may carry secret fields alongside the
    //      status (psd-credentials exercises precisely this), so it is
    //      reported by status alone and never echoed.
    //   3. the status on its own.
    const reason =
      body && typeof body.error === 'string'
        ? body.error
        : parseFailed
          ? bodySnippet(raw)
          : `HTTP ${response.status}`;
    const error = new Error(
      `Agent broker rejected the request (HTTP ${response.status}): ${reason}`
    );
    error.status = response.status;
    error.responseBody = body ?? raw;
    throw error;
  }

  // A 2xx that is not JSON is a genuine contract violation — still report the
  // status and a snippet so the shape is identifiable.
  if (parseFailed) {
    const error = new Error(
      `Agent broker returned invalid JSON (HTTP ${response.status}): ${bodySnippet(raw)}`
    );
    error.status = response.status;
    error.responseBody = raw;
    throw error;
  }
  return body;
}

/**
 * Collapse a response body to a single bounded line for an error message.
 * Bounded because the body may be an entire HTML error page.
 */
function bodySnippet(raw) {
  if (typeof raw !== 'string') return '';
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (!flat) return '(empty body)';
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

module.exports = {
  ALLOWED_ROUTES,
  brokerUrl,
  requestAgentBroker,
};
