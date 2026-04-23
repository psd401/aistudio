/**
 * Shared helpers for the psd-skills-meta OpenClaw skill.
 *
 * Environment contract (set in agent-platform-stack.ts):
 *   AWS_REGION                    — e.g. us-east-1
 *   ENVIRONMENT                   — dev/staging/prod
 *   WORKSPACE_BUCKET              — S3 bucket for skills storage
 *   DATABASE_RESOURCE_ARN         — Aurora cluster ARN for skill registry
 *   DATABASE_SECRET_ARN           — Secret ARN for DB auth
 *   SKILL_BUILDER_LAMBDA_ARN      — ARN of the Skill Builder Lambda
 */

'use strict';

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require('@aws-sdk/client-s3');

const {
  RDSDataClient,
  ExecuteStatementCommand,
} = require('@aws-sdk/client-rds-data');

const {
  LambdaClient,
  InvokeCommand,
} = require('@aws-sdk/client-lambda');

const REGION = process.env.AWS_REGION || 'us-east-1';
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const BUCKET = process.env.WORKSPACE_BUCKET || '';
const DATABASE_RESOURCE_ARN = process.env.DATABASE_RESOURCE_ARN || '';
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN || '';
const SKILL_BUILDER_LAMBDA_ARN = process.env.SKILL_BUILDER_LAMBDA_ARN || '';

const s3 = new S3Client({ region: REGION });
const rds = DATABASE_RESOURCE_ARN ? new RDSDataClient({ region: REGION }) : null;
const lambdaClient = SKILL_BUILDER_LAMBDA_ARN ? new LambdaClient({ region: REGION }) : null;

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
 * Validate that a name is safe for use in S3 keys and Secrets Manager paths.
 * Allows alphanumeric, hyphens, underscores, and dots only.
 */
const SAFE_NAME_RE = /^[a-zA-Z0-9_.-]+$/;
function validateSafeName(name, label) {
  if (!name || !SAFE_NAME_RE.test(name)) {
    fail(`Invalid ${label}: "${name}". Only alphanumeric, hyphens, underscores, and dots allowed.`);
  }
}

/**
 * Escape SQL ILIKE wildcard characters (%, _) in a search string
 * so user input is matched literally.
 */
function escapeIlikeWildcards(str) {
  return str.replace(/[%_\\]/g, (ch) => '\\' + ch);
}

/**
 * Search the skill catalog (name + summary only).
 */
async function searchSkills(query, userEmail) {
  if (!rds) {
    fail('Database not configured — cannot search skills');
  }

  // C2 fix: Escape ILIKE wildcards (%, _) so user input is matched literally
  const escapedQuery = escapeIlikeWildcards(query);

  const resp = await rds.send(new ExecuteStatementCommand({
    resourceArn: DATABASE_RESOURCE_ARN,
    secretArn: DATABASE_SECRET_ARN,
    database: 'aistudio',
    sql: `SELECT id, name, scope, summary, scan_status
          FROM psd_agent_skills
          WHERE (scope = 'shared' OR (scope = 'user' AND owner_user_id IN (
            SELECT id FROM users WHERE email = :email
          )))
          AND (name ILIKE '%' || :q || '%' ESCAPE '\\' OR summary ILIKE '%' || :q || '%' ESCAPE '\\')
          AND scan_status = 'clean'
          ORDER BY name
          LIMIT 20`,
    parameters: [
      { name: 'email', value: { stringValue: userEmail } },
      { name: 'q', value: { stringValue: escapedQuery } },
    ],
  }));

  return (resp.records || []).map((row) => ({
    id: row[0]?.stringValue || '',
    name: row[1]?.stringValue || '',
    scope: row[2]?.stringValue || '',
    summary: row[3]?.stringValue || '',
    scanStatus: row[4]?.stringValue || '',
  }));
}

/**
 * Load a skill's SKILL.md content from S3.
 */
async function loadSkillMd(skillName, userEmail) {
  if (!rds) {
    fail('Database not configured — cannot load skill');
  }

  // Look up the S3 key from the registry
  const resp = await rds.send(new ExecuteStatementCommand({
    resourceArn: DATABASE_RESOURCE_ARN,
    secretArn: DATABASE_SECRET_ARN,
    database: 'aistudio',
    sql: `SELECT s3_key FROM psd_agent_skills
          WHERE name = :name
          AND (scope = 'shared' OR (scope = 'user' AND owner_user_id IN (
            SELECT id FROM users WHERE email = :email
          )))
          AND scan_status = 'clean'
          LIMIT 1`,
    parameters: [
      { name: 'name', value: { stringValue: skillName } },
      { name: 'email', value: { stringValue: userEmail } },
    ],
  }));

  const rows = resp.records || [];
  if (rows.length === 0) {
    return null;
  }

  const s3Key = rows[0][0]?.stringValue;
  if (!s3Key) return null;

  // Read SKILL.md from S3
  const skillMdKey = `${s3Key.replace(/\/$/, '')}/SKILL.md`;
  try {
    const getResp = await s3.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: skillMdKey,
    }));

    if (getResp.Body) {
      const chunks = [];
      for await (const chunk of getResp.Body) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString('utf-8');
    }
  } catch (err) {
    if (err.name === 'NoSuchKey') return null;
    throw err;
  }

  return null;
}

/**
 * Write a skill draft to S3 and register it in the database.
 */
async function authorSkill(skillName, summary, skillMdContent, files, userEmail) {
  if (!rds) {
    fail('Database not configured — cannot author skill');
  }

  // H2 fix: Validate skillName to prevent S3 path traversal
  validateSafeName(skillName, 'skill name');

  const draftPrefix = `skills/user/${userEmail}/drafts/${skillName}`;

  // Write SKILL.md to S3
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `${draftPrefix}/SKILL.md`,
    Body: skillMdContent,
    ContentType: 'text/markdown',
    Tagging: `Environment=${ENVIRONMENT}&ManagedBy=cdk&Scope=draft&Owner=${encodeURIComponent(userEmail)}`,
  }));

  // Write additional files
  for (const file of files) {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${draftPrefix}/${file.path}`,
      Body: Buffer.from(file.content_base64, 'base64'),
      Tagging: `Environment=${ENVIRONMENT}&ManagedBy=cdk&Scope=draft&Owner=${encodeURIComponent(userEmail)}`,
    }));
  }

  // Register in the database
  const insertResp = await rds.send(new ExecuteStatementCommand({
    resourceArn: DATABASE_RESOURCE_ARN,
    secretArn: DATABASE_SECRET_ARN,
    database: 'aistudio',
    sql: `INSERT INTO psd_agent_skills (name, scope, owner_user_id, s3_key, summary, scan_status)
          VALUES (:name, 'draft', (SELECT id FROM users WHERE email = :email LIMIT 1), :s3key, :summary, 'pending')
          ON CONFLICT (name, owner_user_id) WHERE scope = 'draft'
          DO UPDATE SET s3_key = :s3key, summary = :summary, scan_status = 'pending',
                       version = psd_agent_skills.version + 1, updated_at = NOW()
          RETURNING id::text`,
    parameters: [
      { name: 'name', value: { stringValue: skillName } },
      { name: 'email', value: { stringValue: userEmail } },
      { name: 's3key', value: { stringValue: draftPrefix } },
      { name: 'summary', value: { stringValue: summary } },
    ],
  }));

  const skillId = insertResp.records?.[0]?.[0]?.stringValue || 'unknown';

  // Invoke the Skill Builder Lambda for scanning and promotion
  if (lambdaClient && SKILL_BUILDER_LAMBDA_ARN) {
    try {
      await lambdaClient.send(new InvokeCommand({
        FunctionName: SKILL_BUILDER_LAMBDA_ARN,
        InvocationType: 'Event', // Async — don't block the agent turn
        Payload: JSON.stringify({
          skillId,
          s3Key: draftPrefix,
          destinationPrefix: `skills/user/${userEmail}/approved/${skillName}`,
          scope: 'user',
          ownerUserId: null, // Resolved in Lambda from DB
        }),
      }));
    } catch (err) {
      // Lambda invocation failure is non-fatal. The skill stays as a draft
      // and can be retried or manually promoted by admin.
      console.error(`Skill Builder Lambda invocation failed (non-fatal): ${err.message}`);
    }
  }

  return skillId;
}

module.exports = {
  REGION,
  ENVIRONMENT,
  BUCKET,
  fail,
  validateEnv,
  validateUserEmail,
  validateSafeName,
  parseArgs,
  emit,
  searchSkills,
  loadSkillMd,
  authorSkill,
};
