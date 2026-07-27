/**
 * Agent Skill Builder Lambda
 *
 * Invoked per-promotion when a skill passes the automated scan or an admin
 * approves a shared skill. Responsibilities:
 *
 * 1. Download the draft skill from S3
 * 2. Run automated security scan (secret detection, PII patterns, SKILL.md lint)
 * 3. Run `npm install --production` in Lambda /tmp (sandboxed)
 * 4. Tar the result (including node_modules)
 * 5. Upload to the destination S3 prefix (user/approved/ or shared/)
 * 6. Update the skill registry in Aurora (scope, scan_status)
 * 7. Write audit log entry
 *
 * Part of Epic #910 — Agent Skills Platform
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { execSync, type ExecSyncOptionsWithStringEncoding } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Handler } from 'aws-lambda';
import { findMalformedToolVersionPins } from './frontmatter-tools';

const REGION = process.env.AWS_REGION || 'us-east-1';
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const BUCKET = process.env.SKILLS_BUCKET || '';
const DATABASE_RESOURCE_ARN = process.env.DATABASE_RESOURCE_ARN || '';
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN || '';
const DATABASE_NAME = process.env.DATABASE_NAME || 'aistudio';
const MAX_SKILL_INPUT_FILES = 50;
const MAX_SKILL_INPUT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_INPUT_TOTAL_BYTES = 10 * 1024 * 1024;

const s3 = new S3Client({ region: REGION });
const rds = new RDSDataClient({ region: REGION });

// Structured logger — emits JSON to stdout/stderr (matches other Lambdas in
// the repo: agent-cron, agent-router). CloudWatch parses these lines and
// integrates with our observability stack.
type LambdaLogger = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
};

function createLogger(context: Record<string, unknown> = {}): LambdaLogger {
  const base = { service: 'agent-skill-builder', ...context };
  const emit = (
    level: 'INFO' | 'WARN' | 'ERROR',
    stream: NodeJS.WritableStream,
    msg: string,
    meta: Record<string, unknown> = {},
  ) => {
    stream.write(
      JSON.stringify({
        level,
        message: msg,
        timestamp: new Date().toISOString(),
        ...base,
        ...meta,
      }) + '\n',
    );
  };
  return {
    info: (m, meta) => emit('INFO', process.stdout, m, meta),
    warn: (m, meta) => emit('WARN', process.stdout, m, meta),
    error: (m, meta) => emit('ERROR', process.stderr, m, meta),
  };
}

const VALID_SCOPES = ['user', 'shared'] as const;
type ValidScope = (typeof VALID_SCOPES)[number];

function isValidScope(s: unknown): s is ValidScope {
  return typeof s === 'string' && (VALID_SCOPES as readonly string[]).includes(s);
}

// Patterns that indicate secrets in code files
const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|secret|password|passwd|token|credential|auth)[\s]*[=:]\s*['"][^'"]{8,}/gi,
  /(?:api[_-]?key|apikey|secret|password|passwd|token|credential|auth)[\s]*[=:]\s*(?!['"])[^\s]{8,}/gi, // Unquoted values (e.g. .env files)
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g, // AWS access key
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
  /ghp_[A-Za-z0-9_]{36}/g, // GitHub personal access token
  /sk-[A-Za-z0-9]{48}/g, // OpenAI API key
];

// PII patterns
const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
  /\b[A-Za-z0-9._%+-]+@(?!example\.com\b|test\.com\b|localhost\b)[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, // Email (excludes placeholder domains)
  /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, // Phone number
];

interface SkillBuildEvent {
  skillId: string;
  ownerKey: string;
  version: number;
  scanLeaseId: string;
  idempotencyKey: string;
  s3Key: string;
  destinationPrefix: string;
  scope: 'user' | 'shared';
  ownerUserId?: number;
  actorUserId?: number;
}

interface ScanFindings {
  secrets: string[];
  pii: string[];
  npmAudit: { severity: string; title: string }[];
  skillMdLint: string[];
  summary: string;
}

export function assertSkillScanPrefixes(event: Pick<
  SkillBuildEvent,
  'ownerKey' | 's3Key' | 'destinationPrefix'
>): void {
  const ownerPrefix = `skills/user/${event.ownerKey.toLowerCase()}/`;
  const draftPath = event.s3Key.startsWith(ownerPrefix)
    ? event.s3Key.slice(ownerPrefix.length)
    : "";
  const draftMatch = draftPath.match(
    /^drafts\/([a-zA-Z0-9_.-]+)\/versions\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i,
  );
  if (!draftMatch) {
    throw new Error('Invalid owner-bound skill scan prefixes');
  }
  const [, slug, generation] = draftMatch;
  const expectedDestination =
    `${ownerPrefix}approved/${slug}/versions/${generation}`;
  if (event.destinationPrefix !== expectedDestination) {
    throw new Error('Invalid owner-bound skill scan prefixes');
  }
}

export function shouldRollbackDestinationUpload(
  destinationUploaded: boolean,
  promotionCommitted: boolean,
): boolean {
  return destinationUploaded && !promotionCommitted;
}

export const handler: Handler<SkillBuildEvent> = async (event) => {
  const log = createLogger({ skillId: event.skillId });

  // Validate scope at the entry point so a bad value fails fast with a
  // clear error rather than surfacing as a CAST failure inside the RDS Data
  // API call. The DB enum is the source of truth for allowed values.
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.skillId) ||
    typeof event.ownerKey !== 'string' ||
    !/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(event.ownerKey) ||
    !isValidScope(event.scope) ||
    !Number.isSafeInteger(event.version) ||
    event.version < 1 ||
    !/^[0-9a-f-]{36}$/i.test(event.scanLeaseId) ||
    typeof event.idempotencyKey !== 'string' ||
    event.idempotencyKey.length === 0 ||
    event.idempotencyKey.length > 256
  ) {
    log.error('Invalid scope in SkillBuildEvent', { scope: event.scope });
    throw new Error('Invalid skill scan event');
  }
  assertSkillScanPrefixes(event);

  log.info('Skill build event received', {
    s3Key: event.s3Key,
    scope: event.scope,
  });

  const workDir = path.join('/tmp', `skill-${event.skillId}-${Date.now()}`);
  let claimed = false;
  let destinationUploaded = false;
  let promotionCommitted = false;

  try {
    claimed = await claimSkillScan(event);
    if (!claimed) {
      log.warn('Ignoring stale or duplicate skill scan event', {
        version: event.version,
      });
      return { status: 'stale', skillId: event.skillId };
    }
    // 1. Download skill files from S3
    await downloadSkillFromS3(event.s3Key, workDir, log);

    // 2. Run automated scan
    const findings = await scanSkill(workDir);

    // 3. Check if scan is clean. Dependency-vulnerability auditing does NOT run
    // here — `npm audit` needs a resolved lockfile/node_modules, which don't
    // exist pre-install, so it runs post-install below (REV-INFRA-062). This
    // gate covers the pre-install secret/PII checks only.
    const isFlagged = findings.secrets.length > 0 ||
      findings.pii.length > 0;

    if (isFlagged) {
      // Update DB: mark as flagged with findings
      if (!await updateSkillStatus(event, 'flagged', findings)) {
        return { status: 'stale', skillId: event.skillId };
      }
      await writeAuditLog(event.skillId, 'scan_flagged', event.actorUserId, {
        findings: findings.summary,
      });

      return {
        status: 'flagged',
        skillId: event.skillId,
        findings,
      };
    }

    // 4. Run npm install in sandbox
    const packageJsonPath = path.join(workDir, 'package.json');
    let dependencyAuditEvidence:
      | { status: 'not_applicable' }
      | { status: 'clean'; lockfileSha256: string };
    if (fs.existsSync(packageJsonPath)) {
      try {
        installSkillDependencies(workDir);
      } catch (npmErr: unknown) {
        const message = npmErr instanceof Error ? npmErr.message : String(npmErr);
        if (!await updateSkillStatus(event, 'flagged', {
          secrets: [],
          pii: [],
          npmAudit: [],
          skillMdLint: [`npm install failed: ${message.substring(0, 500)}`],
          summary: 'npm install failed',
        })) return { status: 'stale', skillId: event.skillId };
        await writeAuditLog(event.skillId, 'build_failed', event.actorUserId, {
          error: message.substring(0, 500),
        });

        return {
          status: 'build_failed',
          skillId: event.skillId,
          error: message.substring(0, 500),
        };
      }

      // 4b. Audit the *resolved* dependency tree now that `npm install` has
      // produced a package-lock.json + node_modules. npm audit is a no-op
      // (ENOLOCK) before install, which is why the pre-install scan could never
      // catch dependency CVEs (REV-INFRA-062). A high/critical advisory flags
      // the skill and skips promotion — nothing has been uploaded yet.
      let npmAudit: { severity: string; title: string }[];
      let lockfileSha256: string;
      try {
        npmAudit = auditInstalledDeps(workDir, log);
        lockfileSha256 = hashDependencyLockfile(workDir);
      } catch (auditErr: unknown) {
        const message = auditErr instanceof Error ? auditErr.message : String(auditErr);
        const auditFindings: ScanFindings = {
          secrets: [],
          pii: [],
          npmAudit: [],
          skillMdLint: [`Dependency audit unavailable: ${message.substring(0, 500)}`],
          summary: 'dependency audit unavailable',
        };
        if (!await updateSkillStatus(event, 'flagged', auditFindings)) {
          return { status: 'stale', skillId: event.skillId };
        }
        await writeAuditLog(event.skillId, 'audit_error', event.actorUserId, {
          error: message.substring(0, 500),
        });
        return {
          status: 'audit_error',
          skillId: event.skillId,
          findings: auditFindings,
        };
      }
      if (npmAudit.some(a => a.severity === 'critical' || a.severity === 'high')) {
        const auditFindings: ScanFindings = {
          secrets: [],
          pii: [],
          npmAudit,
          skillMdLint: [],
          summary: `${npmAudit.length} high/critical npm vulnerability(ies)`,
        };
        if (!await updateSkillStatus(event, 'flagged', auditFindings)) {
          return { status: 'stale', skillId: event.skillId };
        }
        await writeAuditLog(event.skillId, 'scan_flagged', event.actorUserId, {
          findings: auditFindings.summary,
          dependencyAudit: {
            status: 'vulnerable',
            lockfileSha256,
            findings: npmAudit,
          },
        });

        return {
          status: 'flagged',
          skillId: event.skillId,
          findings: auditFindings,
        };
      }
      dependencyAuditEvidence = { status: 'clean', lockfileSha256 };
    } else {
      dependencyAuditEvidence = { status: 'not_applicable' };
    }

    // 5. Upload built skill to destination prefix
    await uploadSkillToS3(workDir, event.destinationPrefix);
    destinationUploaded = true;

    // 6. Update DB: mark as clean, update scope and s3_key
    const promotionApplied = await updateSkillAfterPromotion(
      event,
      event.scope,
      event.destinationPrefix,
    );
    if (!promotionApplied) {
      await deleteSkillPrefix(event.destinationPrefix);
      destinationUploaded = false;
      return { status: 'stale', skillId: event.skillId };
    }
    // The clean DB row now authoritatively points at these approved bytes.
    // Audit is a subsequent side effect and must never make the catch path
    // delete a destination that has already been durably committed.
    promotionCommitted = true;

    // 7. Write audit log
    const action = event.scope === 'shared' ? 'promoted_to_shared' : 'auto_promoted';
    await writeAuditLog(event.skillId, action, event.actorUserId, {
      destinationPrefix: event.destinationPrefix,
      dependencyAudit: dependencyAuditEvidence,
    });

    return {
      status: 'promoted',
      skillId: event.skillId,
      scope: event.scope,
      s3Key: event.destinationPrefix,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Skill build failed', { error: message });

    if (shouldRollbackDestinationUpload(
      destinationUploaded,
      promotionCommitted,
    )) {
      await deleteSkillPrefix(event.destinationPrefix).catch(() => undefined);
    }
    if (claimed) {
      await clearFailedSkillClaim(event).catch(() => undefined);
    }
    await writeAuditLog(event.skillId, 'build_error', event.actorUserId, {
      error: message.substring(0, 1000),
    }).catch((auditErr: unknown) => {
      const auditMsg = auditErr instanceof Error ? auditErr.message : String(auditErr);
      log.error('Audit log failed (non-fatal)', { error: auditMsg });
    });

    throw err;
  } finally {
    if (claimed) await finishSkillAdmission(event, 1).catch(
      (finishError: unknown) => {
        log.error('Failed to finish skill scan admission lease', {
          error:
            finishError instanceof Error
              ? finishError.message
              : String(finishError),
        });
      },
    );
    // Cleanup /tmp
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
};

export async function downloadSkillFromS3(
  prefix: string,
  destDir: string,
  log: LambdaLogger,
  s3Client: S3Client = s3,
): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });

  // H5 fix: Paginate ListObjectsV2 to handle skills with >1000 files
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  let continuationToken: string | undefined;
  let downloadedFiles = 0;
  let downloadedBytes = 0;
  // Resolve the work-dir root once for the traversal containment check below.
  const destRoot = path.resolve(destDir) + path.sep;

  do {
    const listResp = await s3Client.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: normalizedPrefix,
      ContinuationToken: continuationToken,
    }));

    for (const obj of listResp.Contents || []) {
      if (!obj.Key || obj.Key.endsWith('/')) continue;
      if (downloadedFiles >= MAX_SKILL_INPUT_FILES) {
        throw new Error('Skill input exceeds the file-count limit');
      }
      if (
        typeof obj.Size !== 'number' ||
        obj.Size < 0 ||
        obj.Size > MAX_SKILL_INPUT_FILE_BYTES ||
        downloadedBytes + obj.Size > MAX_SKILL_INPUT_TOTAL_BYTES
      ) {
        throw new Error('Skill input exceeds its declared byte limits');
      }

      const relativePath = obj.Key.slice(normalizedPrefix.length);
      // Path-traversal guard (REV-INFRA-063): S3 keys are user-influenced —
      // draft filenames become key suffixes — and may contain `..` segments.
      // path.join/resolve would normalize `../../x` to a path OUTSIDE destDir,
      // a zip-slip write into /tmp (npm cache, another concurrent build's work
      // dir) that undermines the scan. Reject any key whose resolved
      // destination escapes the per-build work dir.
      const destPath = path.resolve(destDir, relativePath);
      if (!destPath.startsWith(destRoot)) {
        log.warn('Skipping S3 object with path-traversing key', { key: obj.Key });
        continue;
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });

      const getResp = await s3Client.send(new GetObjectCommand({
        Bucket: BUCKET,
        Key: obj.Key,
      }));

      if (getResp.Body) {
        const chunks: Buffer[] = [];
        let objectBytes = 0;
        for await (const chunk of getResp.Body as AsyncIterable<Buffer>) {
          const safeChunk = Buffer.from(chunk);
          objectBytes += safeChunk.byteLength;
          if (
            objectBytes > obj.Size ||
            downloadedBytes + objectBytes > MAX_SKILL_INPUT_TOTAL_BYTES
          ) {
            throw new Error('Skill object exceeded its declared byte limit');
          }
          chunks.push(safeChunk);
        }
        if (objectBytes !== obj.Size) {
          throw new Error('Skill object length did not match its S3 metadata');
        }
        fs.writeFileSync(destPath, Buffer.concat(chunks));
        downloadedFiles += 1;
        downloadedBytes += objectBytes;
      }
    }

    continuationToken = listResp.NextContinuationToken;
  } while (continuationToken);
}

export async function claimSkillScan(
  event: SkillBuildEvent,
  rdsClient: RDSDataClient = rds,
): Promise<boolean> {
  const response = await rdsClient.send(new ExecuteStatementCommand({
    resourceArn: DATABASE_RESOURCE_ARN,
    secretArn: DATABASE_SECRET_ARN,
    database: DATABASE_NAME,
    sql: `UPDATE psd_agent_skills AS skill
          SET scan_lease_id = CAST(:lease AS UUID),
              scan_started_at = NOW(),
              updated_at = NOW()
          FROM users AS owner, resource_admission_leases AS admission
          WHERE skill.id = CAST(:id AS UUID)
            AND skill.owner_user_id = owner.id
            AND LOWER(owner.email) = :owner
            AND skill.version = :version
            AND skill.s3_key = :source
            AND skill.scan_status = 'pending'
            AND admission.id = CAST(:lease AS UUID)
            AND admission.kind = 'skill-scan-events'
            AND admission.owner_key = :owner
            AND admission.context_key = :context
            AND admission.idempotency_key = :idempotency
            AND admission.status = 'active'
            AND admission.expires_at > NOW()
            AND (
              skill.scan_lease_id IS NULL
              OR (
                skill.scan_lease_id = CAST(:lease AS UUID)
                AND skill.scan_started_at < NOW() - INTERVAL '10 minutes'
              )
            )
          RETURNING skill.id`,
    parameters: [
      { name: 'lease', value: { stringValue: event.scanLeaseId } },
      { name: 'id', value: { stringValue: event.skillId } },
      { name: 'version', value: { longValue: event.version } },
      { name: 'source', value: { stringValue: event.s3Key } },
      { name: 'owner', value: { stringValue: event.ownerKey.toLowerCase() } },
      {
        name: 'context',
        value: { stringValue: `${event.skillId}:${event.version}` },
      },
      {
        name: 'idempotency',
        value: { stringValue: event.idempotencyKey },
      },
    ],
  }));
  return (response.records?.length ?? 0) === 1;
}

async function clearFailedSkillClaim(event: SkillBuildEvent): Promise<void> {
  await rds.send(new ExecuteStatementCommand({
    resourceArn: DATABASE_RESOURCE_ARN,
    secretArn: DATABASE_SECRET_ARN,
    database: DATABASE_NAME,
    sql: `UPDATE psd_agent_skills
          SET scan_lease_id = NULL,
              scan_started_at = NULL,
              updated_at = NOW()
          WHERE id = CAST(:id AS UUID)
            AND version = :version
            AND scan_status = 'pending'
            AND scan_lease_id = CAST(:lease AS UUID)`,
    parameters: [
      { name: 'id', value: { stringValue: event.skillId } },
      { name: 'version', value: { longValue: event.version } },
      { name: 'lease', value: { stringValue: event.scanLeaseId } },
    ],
  }));
}

async function finishSkillAdmission(
  event: SkillBuildEvent,
  actualUnits: 1,
): Promise<void> {
  await rds.send(new ExecuteStatementCommand({
    resourceArn: DATABASE_RESOURCE_ARN,
    secretArn: DATABASE_SECRET_ARN,
    database: DATABASE_NAME,
    sql: `UPDATE resource_admission_leases
          SET status = 'completed',
              actual_units = :actual,
              finished_at = NOW()
          WHERE id = CAST(:lease AS UUID)
            AND kind = 'skill-scan-events'
            AND owner_key = :owner
            AND context_key = :context
            AND status = 'active'`,
    parameters: [
      { name: 'actual', value: { longValue: actualUnits } },
      { name: 'lease', value: { stringValue: event.scanLeaseId } },
      { name: 'owner', value: { stringValue: event.ownerKey.toLowerCase() } },
      {
        name: 'context',
        value: { stringValue: `${event.skillId}:${event.version}` },
      },
    ],
  }));
}

async function uploadSkillToS3(srcDir: string, destPrefix: string): Promise<void> {
  const prefix = destPrefix.endsWith('/') ? destPrefix : `${destPrefix}/`;

  function walkDir(dir: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...walkDir(fullPath));
      } else {
        files.push(fullPath);
      }
    }
    return files;
  }

  const files = walkDir(srcDir);

  // Bounded concurrency upload (10 concurrent PutObject calls) to avoid
  // Lambda timeout on skills with many files (e.g. node_modules)
  const CONCURRENCY = 10;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map((filePath) => {
        const relativePath = path.relative(srcDir, filePath);
        const key = `${prefix}${relativePath}`;
        return s3.send(new PutObjectCommand({
          Bucket: BUCKET,
          Key: key,
          Body: fs.readFileSync(filePath),
          Tagging: `Environment=${ENVIRONMENT}&ManagedBy=cdk&Scope=skill`,
        }));
      }),
    );
  }
}

async function deleteSkillPrefix(prefix: string): Promise<void> {
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  let continuationToken: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: normalizedPrefix,
      ContinuationToken: continuationToken,
    }));
    await Promise.all(
      (page.Contents ?? [])
        .filter((item): item is typeof item & { Key: string } =>
          typeof item.Key === 'string' && item.Key.startsWith(normalizedPrefix))
        .map((item) =>
          s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: item.Key }))),
    );
    continuationToken = page.NextContinuationToken;
  } while (continuationToken);
}

async function scanSkill(skillDir: string): Promise<ScanFindings> {
  const findings: ScanFindings = {
    secrets: [],
    pii: [],
    npmAudit: [],
    skillMdLint: [],
    summary: '',
  };

  // Scan all text files for secrets and PII
  function walkAndScan(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walkAndScan(fullPath);
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.js', '.ts', '.json', '.md', '.yaml', '.yml', '.env', '.txt'].includes(ext) || entry.name === '.env') {
          try {
            const content = fs.readFileSync(fullPath, 'utf-8');
            const relativePath = path.relative(skillDir, fullPath);

            // Secret detection — skip comment lines to avoid false positives
            // on documentation examples like `// secret = 'example'`
            const nonCommentLines = content
              .split('\n')
              .filter(line => {
                const trimmed = line.trim();
                return !trimmed.startsWith('//') &&
                       !trimmed.startsWith('#') &&
                       !trimmed.startsWith('*') &&
                       !trimmed.startsWith('/*');
              })
              .join('\n');

            for (const pattern of SECRET_PATTERNS) {
              pattern.lastIndex = 0;
              if (pattern.test(nonCommentLines)) {
                findings.secrets.push(`Potential secret in ${relativePath}`);
              }
            }

            // PII detection (skip SKILL.md example sections)
            if (!entry.name.endsWith('.md')) {
              for (const pattern of PII_PATTERNS) {
                pattern.lastIndex = 0;
                if (pattern.test(content)) {
                  findings.pii.push(`Potential PII in ${relativePath}`);
                }
              }
            }
          } catch {
            // Skip files that can't be read as text
          }
        }
      }
    }
  }

  walkAndScan(skillDir);

  // SKILL.md lint
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    findings.skillMdLint.push('SKILL.md is missing');
  } else {
    const content = fs.readFileSync(skillMdPath, 'utf-8');

    // Check frontmatter
    if (!content.startsWith('---')) {
      findings.skillMdLint.push('SKILL.md missing frontmatter (must start with ---)');
    } else {
      const frontmatterEnd = content.indexOf('---', 3);
      if (frontmatterEnd === -1) {
        findings.skillMdLint.push('SKILL.md frontmatter not closed');
      } else {
        const frontmatter = content.slice(3, frontmatterEnd);
        if (!frontmatter.includes('summary:')) {
          findings.skillMdLint.push('SKILL.md frontmatter missing required "summary" field');
        }
        if (!frontmatter.includes('name:')) {
          findings.skillMdLint.push('SKILL.md frontmatter missing required "name" field');
        }
        // Validate versioned tool references in `allowed-tools` (Issue #927). A
        // pin of the form `identifier@version` must use a well-formed `vN`
        // version token; a malformed pin (e.g. `tool@2`, `tool@latest`) is a typo
        // that would silently fail to match any real tool, so flag it at scan time.
        for (const badPin of findMalformedToolVersionPins(frontmatter)) {
          findings.skillMdLint.push(
            `SKILL.md allowed-tools has a malformed version pin "${badPin}" ` +
              '(expected "identifier@vN", e.g. "documents.create@v2")'
          );
        }
      }
    }
  }

  // NOTE: dependency-vulnerability auditing (npm audit) intentionally does NOT
  // run here. Before `npm install` there is no package-lock.json / node_modules,
  // so `npm audit` is a no-op (ENOLOCK) and never sees a single advisory — which
  // made this gate a no-op (REV-INFRA-062). The audit now runs post-install via
  // auditInstalledDeps() in the handler, against the resolved dependency tree.
  // findings.npmAudit is populated there, not here.

  // Build summary
  const parts: string[] = [];
  if (findings.secrets.length > 0) parts.push(`${findings.secrets.length} potential secret(s)`);
  if (findings.pii.length > 0) parts.push(`${findings.pii.length} potential PII pattern(s)`);
  if (findings.npmAudit.length > 0) parts.push(`${findings.npmAudit.length} high/critical npm vulnerability(ies)`);
  if (findings.skillMdLint.length > 0) parts.push(`${findings.skillMdLint.length} SKILL.md issue(s)`);
  findings.summary = parts.length > 0 ? parts.join(', ') : 'clean';

  return findings;
}

/**
 * Install a skill's production dependencies with npm lifecycle scripts DISABLED.
 *
 * `--ignore-scripts` (belt-and-suspenders: also `npm_config_ignore_scripts`) is
 * load-bearing SECURITY, not an optimization: this installs a user-submitted,
 * unvetted skill's dependencies, and npm runs preinstall/install/postinstall
 * lifecycle scripts by default — arbitrary code execution under the Lambda's
 * execution role. The pre-install scan never inspects lifecycle scripts, so a
 * `postinstall` in the skill's own package.json (or any dependency) would
 * otherwise run unchecked. See REV-INFRA-061.
 */
export function installSkillDependencies(workDir: string): void {
  execSync('npm install --production --ignore-scripts --no-audit --no-fund', {
    cwd: workDir,
    timeout: 120_000, // 2 min max for npm install
    // Only stderr is inspected on failure; piping stdout too risks exceeding
    // Node's default maxBuffer on a verbose install and throwing a
    // false-positive error.
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      HOME: '/tmp',
      npm_config_cache: '/tmp/.npm',
      npm_config_ignore_scripts: 'true',
    },
  });
}

/**
 * Audit the *resolved* dependency tree for known high/critical advisories.
 *
 * Runs AFTER `installSkillDependencies`, when a package-lock.json + node_modules
 * exist — `npm audit` is a no-op (ENOLOCK) without them, which is why the
 * pre-install scan could never see dependency vulns (REV-INFRA-062).
 *
 * Audit tooling failures throw and block promotion. An unevaluated audit is not
 * equivalent to a clean dependency tree. `exec` is injectable for testing.
 */
export function auditInstalledDeps(
  dir: string,
  log: LambdaLogger,
  exec: (command: string, options: ExecSyncOptionsWithStringEncoding) => string = execSync,
): { severity: string; title: string }[] {
  const results: { severity: string; title: string }[] = [];

  let auditOutput: string;
  try {
    // npm audit exits non-zero when vulnerabilities are found, but still
    // writes the JSON report to stdout — capture it from the thrown error
    // below instead of silencing the exit code, so a genuine tooling/network
    // failure (which also exits non-zero, with no usable stdout) is still
    // visible instead of masquerading as "no vulnerabilities".
    auditOutput = exec('npm audit --json --production', {
      cwd: dir,
      timeout: 30_000,
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: '/tmp',
        npm_config_cache: '/tmp/.npm',
      },
    });
  } catch (err: unknown) {
    const stdout = (err as { stdout?: string | Buffer } | undefined)?.stdout;
    if (stdout) {
      auditOutput = typeof stdout === 'string' ? stdout : stdout.toString('utf-8');
    } else {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('npm audit could not run; dependency vulnerabilities were NOT evaluated', {
        error: message.substring(0, 300),
      });
      throw new Error(`Dependency audit could not run: ${message}`, { cause: err });
    }
  }

  let audit: { error?: unknown; vulnerabilities?: Record<string, { severity?: string; name?: string }> };
  try {
    audit = JSON.parse(auditOutput);
  } catch {
    log.warn('npm audit produced no parseable JSON; dependency vulnerabilities were NOT evaluated');
    throw new Error('Dependency audit produced no parseable JSON');
  }

  // A registry/auth failure can still exit with valid JSON that carries a
  // top-level `error` and no `vulnerabilities` key at all (distinct from a
  // clean tree, which reports `vulnerabilities: {}`). Treat that the same as
  // a tooling failure — a visible warning, never a silent "clean" — since
  // the whole point of this gate is that a failed audit must not look like
  // a passed one.
  if (audit.error || !audit.vulnerabilities) {
    log.warn('npm audit did not evaluate dependencies; dependency vulnerabilities were NOT evaluated', {
      error: audit.error ? JSON.stringify(audit.error).substring(0, 300) : undefined,
    });
    throw new Error('Dependency audit did not evaluate dependencies');
  }

  const vulns = audit.vulnerabilities;
  for (const [, info] of Object.entries(vulns)) {
    if (info.severity === 'high' || info.severity === 'critical') {
      results.push({ severity: info.severity, title: info.name || 'unknown' });
    }
  }
  return results;
}

/** Return auditable evidence for the exact dependency graph that was scanned. */
export function hashDependencyLockfile(dir: string): string {
  const lockfilePath = path.join(dir, 'package-lock.json');
  if (!fs.existsSync(lockfilePath)) {
    throw new Error('Dependency audit completed without package-lock.json evidence');
  }
  return createHash('sha256').update(fs.readFileSync(lockfilePath)).digest('hex');
}

async function updateSkillStatus(
  event: SkillBuildEvent,
  scanStatus: string,
  findings: ScanFindings,
): Promise<boolean> {
  const response = await rds.send(new ExecuteStatementCommand({
    resourceArn: DATABASE_RESOURCE_ARN,
    secretArn: DATABASE_SECRET_ARN,
    database: DATABASE_NAME,
    // scan_status is VARCHAR + CHECK (migration 070 — deliberately NOT an enum).
    // Casting to agent_skill_scan_status fails outright on any database that
    // never had the pre-070 partial state (the orphan enum types only exist
    // where that leftover was cleaned up in place), so bind plain text.
    sql: `UPDATE psd_agent_skills
          SET scan_status = :status,
              scan_findings = CAST(:findings AS JSONB),
              updated_at = NOW()
          WHERE id = CAST(:id AS UUID)
            AND version = :version
            AND scan_lease_id = CAST(:lease AS UUID)
          RETURNING id`,
    parameters: [
      { name: 'status', value: { stringValue: scanStatus } },
      { name: 'findings', value: { stringValue: JSON.stringify(findings) } },
      { name: 'id', value: { stringValue: event.skillId } },
      { name: 'version', value: { longValue: event.version } },
      { name: 'lease', value: { stringValue: event.scanLeaseId } },
    ],
  }));
  return (response.records?.length ?? 0) === 1;
}

async function updateSkillAfterPromotion(
  event: SkillBuildEvent,
  scope: string,
  s3Key: string,
): Promise<boolean> {
  const response = await rds.send(new ExecuteStatementCommand({
    resourceArn: DATABASE_RESOURCE_ARN,
    secretArn: DATABASE_SECRET_ARN,
    database: DATABASE_NAME,
    // scope/scan_status are VARCHAR + CHECK, not enums — see updateSkillStatus.
    sql: `UPDATE psd_agent_skills
          SET scope = :scope,
              scan_status = 'clean',
              s3_key = :s3key,
              updated_at = NOW()
          WHERE id = CAST(:id AS UUID)
            AND version = :version
            AND scan_lease_id = CAST(:lease AS UUID)
          RETURNING id`,
    parameters: [
      { name: 'scope', value: { stringValue: scope } },
      { name: 's3key', value: { stringValue: s3Key } },
      { name: 'id', value: { stringValue: event.skillId } },
      { name: 'version', value: { longValue: event.version } },
      { name: 'lease', value: { stringValue: event.scanLeaseId } },
    ],
  }));
  return (response.records?.length ?? 0) === 1;
}

async function writeAuditLog(
  skillId: string,
  action: string,
  actorUserId: number | undefined,
  details: Record<string, unknown>,
): Promise<void> {
  await rds.send(new ExecuteStatementCommand({
    resourceArn: DATABASE_RESOURCE_ARN,
    secretArn: DATABASE_SECRET_ARN,
    database: DATABASE_NAME,
    sql: `INSERT INTO psd_agent_skill_audit (skill_id, action, actor_user_id, details)
          VALUES (CAST(:skill AS UUID), :action, :actor, CAST(:details AS JSONB))`,
    parameters: [
      { name: 'skill', value: { stringValue: skillId } },
      { name: 'action', value: { stringValue: action } },
      { name: 'actor', value: actorUserId != null ? { longValue: actorUserId } : { isNull: true } },
      { name: 'details', value: { stringValue: JSON.stringify(details) } },
    ],
  }));
}
