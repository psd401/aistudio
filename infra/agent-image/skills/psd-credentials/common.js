/**
 * Shared helpers for the psd-credentials OpenClaw skill.
 *
 * Reads environment variables injected by the AgentCore runtime.
 * Resolves credential names to Secrets Manager ARNs using the
 * naming convention: psd-agent-creds/{env}/shared/{name} and
 * psd-agent-creds/{env}/user/{userId}/{name}.
 *
 * Environment contract (set in agent-platform-stack.ts):
 *   AWS_REGION                    — e.g. us-east-1
 *   ENVIRONMENT                   — dev/staging/prod
 *   DATABASE_RESOURCE_ARN         — Aurora cluster ARN for telemetry writes
 *   DATABASE_SECRET_ARN           — Secret ARN for DB auth
 */

'use strict';

const {
  SecretsManagerClient,
  GetSecretValueCommand,
  ListSecretsCommand,
} = require('@aws-sdk/client-secrets-manager');

const {
  RDSDataClient,
  ExecuteStatementCommand,
} = require('@aws-sdk/client-rds-data');

const REGION = process.env.AWS_REGION || 'us-east-1';
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const DATABASE_RESOURCE_ARN = process.env.DATABASE_RESOURCE_ARN || '';
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN || '';

const CREDS_PREFIX = `psd-agent-creds/${ENVIRONMENT}`;

// Module-scope clients — reused within the skill invocation
const smClient = new SecretsManagerClient({ region: REGION });
const rdsClient = DATABASE_RESOURCE_ARN
  ? new RDSDataClient({ region: REGION })
  : null;

// In-memory cache for the session. Keys: credential name, values: secret string.
const _cache = Object.create(null);

function fail(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function validateEnv() {
  if (!ENVIRONMENT) fail('ENVIRONMENT env var not set');
}

function validateUserEmail(email) {
  if (!email) fail('--user is required (authenticated caller email)');
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!EMAIL.test(email)) {
    fail(`Invalid --user "${email}". Must be a valid email address.`);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      fail(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2).replace(/-/g, '_');
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * Validate that a credential name is safe for use in Secrets Manager paths.
 * Allows alphanumeric, hyphens, underscores, and dots only.
 * Prevents path traversal via / or .. in the name.
 */
const SAFE_CRED_NAME_RE = /^[a-zA-Z0-9_.-]+$/;
function validateCredentialName(name) {
  if (!name || !SAFE_CRED_NAME_RE.test(name)) {
    fail(`Invalid credential name: "${name}". Only alphanumeric, hyphens, underscores, and dots allowed.`);
  }
}

/**
 * Resolve a credential name to Secrets Manager secret ID.
 * Priority: user-specific first, then shared.
 */
function resolveSecretId(name, userEmail) {
  return {
    userPath: `${CREDS_PREFIX}/user/${userEmail}/${name}`,
    sharedPath: `${CREDS_PREFIX}/shared/${name}`,
  };
}

/**
 * Fetch a secret value from Secrets Manager, checking user scope first,
 * then falling back to shared scope. Uses in-memory cache.
 */
async function getCredential(name, userEmail) {
  // H1 fix: Validate credential name to prevent path traversal in SM paths
  validateCredentialName(name);

  const cacheKey = `${userEmail}:${name}`;
  if (cacheKey in _cache) {
    return _cache[cacheKey];
  }

  const { userPath, sharedPath } = resolveSecretId(name, userEmail);

  // Try user-scoped first
  let value = await tryGetSecret(userPath);
  let scope = 'user';

  // Fall back to shared
  if (value === null) {
    value = await tryGetSecret(sharedPath);
    scope = 'shared';
  }

  if (value === null) {
    return null;
  }

  const result = { name, value, scope };
  _cache[cacheKey] = result;
  return result;
}

/**
 * Try to get a secret value. Returns null if not found.
 */
async function tryGetSecret(secretId) {
  try {
    const resp = await smClient.send(new GetSecretValueCommand({
      SecretId: secretId,
    }));
    return resp.SecretString || null;
  } catch (err) {
    if (err.name === 'ResourceNotFoundException') {
      return null;
    }
    // H3 fix: Log AccessDeniedException to stderr for telemetry visibility
    // instead of silently swallowing — helps detect IAM misconfigurations
    // and potential probing. Never log the secret value (only the path).
    if (err.name === 'AccessDeniedException') {
      console.error(`AccessDenied for secret "${secretId}" (non-fatal, treated as not found)`);
      return null;
    }
    throw err;
  }
}

/**
 * List all credentials the user has access to (names and scopes, never values).
 */
async function listCredentials(userEmail) {
  const credentials = [];

  // List shared credentials
  const sharedPrefix = `${CREDS_PREFIX}/shared/`;
  const sharedSecrets = await listSecretsByPrefix(sharedPrefix);
  for (const s of sharedSecrets) {
    const name = s.Name.slice(sharedPrefix.length);
    if (name) {
      credentials.push({ name, scope: 'shared' });
    }
  }

  // List user-specific credentials
  const userPrefix = `${CREDS_PREFIX}/user/${userEmail}/`;
  const userSecrets = await listSecretsByPrefix(userPrefix);
  for (const s of userSecrets) {
    const name = s.Name.slice(userPrefix.length);
    if (name) {
      credentials.push({ name, scope: 'user' });
    }
  }

  return credentials;
}

/**
 * List secrets by name prefix from Secrets Manager.
 */
async function listSecretsByPrefix(prefix) {
  const secrets = [];
  let nextToken;

  do {
    const resp = await smClient.send(new ListSecretsCommand({
      Filters: [{ Key: 'name', Values: [prefix] }],
      NextToken: nextToken,
      MaxResults: 100,
    }));
    secrets.push(...(resp.SecretList || []));
    nextToken = resp.NextToken;
  } while (nextToken);

  return secrets;
}

/**
 * Log a credential read to the telemetry database.
 * Never logs the credential value — only name, user, session.
 */
async function logCredentialRead(credentialName, userEmail, sessionId) {
  if (!rdsClient || !DATABASE_RESOURCE_ARN || !DATABASE_SECRET_ARN) {
    // Telemetry is best-effort; skip if DB not configured
    return;
  }

  try {
    await rdsClient.send(new ExecuteStatementCommand({
      resourceArn: DATABASE_RESOURCE_ARN,
      secretArn: DATABASE_SECRET_ARN,
      database: 'aistudio',
      sql: `INSERT INTO psd_agent_credential_reads (credential_name, user_id, session_id) VALUES (:name, :user, :session)`,
      parameters: [
        { name: 'name', value: { stringValue: credentialName } },
        { name: 'user', value: { stringValue: userEmail } },
        { name: 'session', value: { stringValue: sessionId || 'unknown' } },
      ],
    }));
  } catch (err) {
    // Best-effort telemetry — don't fail the skill if logging fails
    console.error(`Telemetry log failed (non-fatal): ${err.message}`);
  }
}

/**
 * Insert a credential request into the database.
 */
async function insertCredentialRequest(credentialName, reason, skillContext, userEmail) {
  // H1 fix: Validate credential name to prevent path traversal
  validateCredentialName(credentialName);

  if (!rdsClient || !DATABASE_RESOURCE_ARN || !DATABASE_SECRET_ARN) {
    fail('Database not configured — cannot file credential requests');
  }

  const resp = await rdsClient.send(new ExecuteStatementCommand({
    resourceArn: DATABASE_RESOURCE_ARN,
    secretArn: DATABASE_SECRET_ARN,
    database: 'aistudio',
    sql: `INSERT INTO psd_agent_credential_requests (credential_name, reason, skill_context, requested_by)
          VALUES (:name, :reason, :ctx, :user)
          RETURNING id`,
    parameters: [
      { name: 'name', value: { stringValue: credentialName } },
      { name: 'reason', value: { stringValue: reason } },
      { name: 'ctx', value: skillContext ? { stringValue: skillContext } : { isNull: true } },
      { name: 'user', value: { stringValue: userEmail } },
    ],
  }));

  const rows = resp.records || [];
  if (rows.length > 0 && rows[0].length > 0) {
    return rows[0][0].longValue || rows[0][0].stringValue || 'unknown';
  }
  return 'unknown';
}

module.exports = {
  REGION,
  ENVIRONMENT,
  fail,
  validateEnv,
  validateUserEmail,
  validateCredentialName,
  parseArgs,
  emit,
  getCredential,
  listCredentials,
  logCredentialRead,
  insertCredentialRequest,
};
