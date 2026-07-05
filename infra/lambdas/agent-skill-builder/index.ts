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

import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { RDSDataClient, ExecuteStatementCommand } from '@aws-sdk/client-rds-data';
import { execSync, type ExecSyncOptionsWithStringEncoding } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Handler } from 'aws-lambda';
import { findMalformedToolVersionPins } from './frontmatter-tools';

const REGION = process.env.AWS_REGION || 'us-east-1';
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const BUCKET = process.env.SKILLS_BUCKET || '';
const DATABASE_RESOURCE_ARN = process.env.DATABASE_RESOURCE_ARN || '';
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN || '';
const DATABASE_NAME = process.env.DATABASE_NAME || 'aistudio';

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

export const handler: Handler<SkillBuildEvent> = async (event) => {
  const log = createLogger({ skillId: event.skillId });

  // Validate scope at the entry point so a bad value fails fast with a
  // clear error rather than surfacing as a CAST failure inside the RDS Data
  // API call. The DB enum is the source of truth for allowed values.
  if (!isValidScope(event.scope)) {
    log.error('Invalid scope in SkillBuildEvent', { scope: event.scope });
    throw new Error(`Invalid scope: ${event.scope}. Must be one of: ${VALID_SCOPES.join(', ')}`);
  }

  log.info('Skill build event received', {
    s3Key: event.s3Key,
    scope: event.scope,
  });

  const workDir = path.join('/tmp', `skill-${event.skillId}-${Date.now()}`);

  try {
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
      await updateSkillStatus(event.skillId, 'flagged', findings);
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
    if (fs.existsSync(packageJsonPath)) {
      try {
        installSkillDependencies(workDir);
      } catch (npmErr: unknown) {
        const message = npmErr instanceof Error ? npmErr.message : String(npmErr);
        await updateSkillStatus(event.skillId, 'flagged', {
          secrets: [],
          pii: [],
          npmAudit: [],
          skillMdLint: [`npm install failed: ${message.substring(0, 500)}`],
          summary: 'npm install failed',
        });
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
      const npmAudit = auditInstalledDeps(workDir, log);
      if (npmAudit.some(a => a.severity === 'critical' || a.severity === 'high')) {
        const auditFindings: ScanFindings = {
          secrets: [],
          pii: [],
          npmAudit,
          skillMdLint: [],
          summary: `${npmAudit.length} high/critical npm vulnerability(ies)`,
        };
        await updateSkillStatus(event.skillId, 'flagged', auditFindings);
        await writeAuditLog(event.skillId, 'scan_flagged', event.actorUserId, {
          findings: auditFindings.summary,
        });

        return {
          status: 'flagged',
          skillId: event.skillId,
          findings: auditFindings,
        };
      }
    }

    // 5. Upload built skill to destination prefix
    await uploadSkillToS3(workDir, event.destinationPrefix);

    // 6. Update DB: mark as clean, update scope and s3_key
    await updateSkillAfterPromotion(
      event.skillId,
      event.scope,
      event.destinationPrefix,
    );

    // 7. Write audit log
    const action = event.scope === 'shared' ? 'promoted_to_shared' : 'auto_promoted';
    await writeAuditLog(event.skillId, action, event.actorUserId, {
      destinationPrefix: event.destinationPrefix,
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

    await writeAuditLog(event.skillId, 'build_error', event.actorUserId, {
      error: message.substring(0, 1000),
    }).catch((auditErr: unknown) => {
      const auditMsg = auditErr instanceof Error ? auditErr.message : String(auditErr);
      log.error('Audit log failed (non-fatal)', { error: auditMsg });
    });

    throw err;
  } finally {
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

      const relativePath = obj.Key.slice(prefix.length).replace(/^\/+/, '');
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
        for await (const chunk of getResp.Body as AsyncIterable<Buffer>) {
          chunks.push(chunk);
        }
        fs.writeFileSync(destPath, Buffer.concat(chunks));
      }
    }

    continuationToken = listResp.NextContinuationToken;
  } while (continuationToken);
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
    stdio: 'pipe',
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
 * Graceful degradation (documented behavior): if the audit tooling itself
 * cannot produce parseable JSON (npm/network error), we log a WARNING and
 * return []. A tooling error is therefore VISIBLE in logs, never a silent
 * "clean" — but it does not hard-block promotion, matching the best-effort
 * intent of the other scan steps. `exec` is injectable for testing.
 */
export function auditInstalledDeps(
  dir: string,
  log: LambdaLogger,
  exec: (command: string, options: ExecSyncOptionsWithStringEncoding) => string = execSync,
): { severity: string; title: string }[] {
  const results: { severity: string; title: string }[] = [];

  let auditOutput: string;
  try {
    // `|| true` so a non-zero exit (npm audit returns 1 when vulns exist) still
    // yields the JSON on stdout instead of throwing before we can parse it.
    auditOutput = exec('npm audit --json --production 2>/dev/null || true', {
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
    const message = err instanceof Error ? err.message : String(err);
    log.warn('npm audit could not run; dependency vulnerabilities were NOT evaluated', {
      error: message.substring(0, 300),
    });
    return results;
  }

  let audit: { vulnerabilities?: Record<string, { severity?: string; name?: string }> };
  try {
    audit = JSON.parse(auditOutput);
  } catch {
    log.warn('npm audit produced no parseable JSON; dependency vulnerabilities were NOT evaluated');
    return results;
  }

  const vulns = audit.vulnerabilities || {};
  for (const [, info] of Object.entries(vulns)) {
    if (info.severity === 'high' || info.severity === 'critical') {
      results.push({ severity: info.severity, title: info.name || 'unknown' });
    }
  }
  return results;
}

async function updateSkillStatus(
  skillId: string,
  scanStatus: string,
  findings: ScanFindings,
): Promise<void> {
  await rds.send(new ExecuteStatementCommand({
    resourceArn: DATABASE_RESOURCE_ARN,
    secretArn: DATABASE_SECRET_ARN,
    database: DATABASE_NAME,
    sql: `UPDATE psd_agent_skills
          SET scan_status = CAST(:status AS agent_skill_scan_status),
              scan_findings = CAST(:findings AS JSONB),
              updated_at = NOW()
          WHERE id = CAST(:id AS UUID)`,
    parameters: [
      { name: 'status', value: { stringValue: scanStatus } },
      { name: 'findings', value: { stringValue: JSON.stringify(findings) } },
      { name: 'id', value: { stringValue: skillId } },
    ],
  }));
}

async function updateSkillAfterPromotion(
  skillId: string,
  scope: string,
  s3Key: string,
): Promise<void> {
  await rds.send(new ExecuteStatementCommand({
    resourceArn: DATABASE_RESOURCE_ARN,
    secretArn: DATABASE_SECRET_ARN,
    database: DATABASE_NAME,
    sql: `UPDATE psd_agent_skills
          SET scope = CAST(:scope AS agent_skill_scope),
              scan_status = 'clean'::agent_skill_scan_status,
              s3_key = :s3key,
              updated_at = NOW()
          WHERE id = CAST(:id AS UUID)`,
    parameters: [
      { name: 'scope', value: { stringValue: scope } },
      { name: 's3key', value: { stringValue: s3Key } },
      { name: 'id', value: { stringValue: skillId } },
    ],
  }));
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
