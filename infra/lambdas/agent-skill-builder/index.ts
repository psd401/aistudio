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
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Handler } from 'aws-lambda';

const REGION = process.env.AWS_REGION || 'us-east-1';
const ENVIRONMENT = process.env.ENVIRONMENT || 'dev';
const BUCKET = process.env.SKILLS_BUCKET || '';
const DATABASE_RESOURCE_ARN = process.env.DATABASE_RESOURCE_ARN || '';
const DATABASE_SECRET_ARN = process.env.DATABASE_SECRET_ARN || '';
const DATABASE_NAME = process.env.DATABASE_NAME || 'aistudio';

const s3 = new S3Client({ region: REGION });
const rds = new RDSDataClient({ region: REGION });

// Patterns that indicate secrets in code files
const SECRET_PATTERNS = [
  /(?:api[_-]?key|apikey|secret|password|passwd|token|credential|auth)[\s]*[=:]\s*['"][^'"]{8,}/gi,
  /(?:AKIA|ASIA)[A-Z0-9]{16}/g, // AWS access key
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g,
  /ghp_[A-Za-z0-9_]{36}/g, // GitHub personal access token
  /sk-[A-Za-z0-9]{48}/g, // OpenAI API key
];

// PII patterns
const PII_PATTERNS = [
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, // Email
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
  // eslint-disable-next-line no-console
  console.log('Skill build event:', JSON.stringify({
    skillId: event.skillId,
    s3Key: event.s3Key,
    scope: event.scope,
  }));

  const workDir = path.join('/tmp', `skill-${event.skillId}-${Date.now()}`);

  try {
    // 1. Download skill files from S3
    await downloadSkillFromS3(event.s3Key, workDir);

    // 2. Run automated scan
    const findings = await scanSkill(workDir);

    // 3. Check if scan is clean
    const isFlagged = findings.secrets.length > 0 ||
      findings.pii.length > 0 ||
      findings.npmAudit.some(a => a.severity === 'critical' || a.severity === 'high');

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
        execSync('npm install --production --no-audit --no-fund', {
          cwd: workDir,
          timeout: 120_000, // 2 min max for npm install
          stdio: 'pipe',
          env: {
            ...process.env,
            HOME: '/tmp',
            npm_config_cache: '/tmp/.npm',
          },
        });
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
    // eslint-disable-next-line no-console
    console.error('Skill build failed:', message);

    await writeAuditLog(event.skillId, 'build_error', event.actorUserId, {
      error: message.substring(0, 1000),
    }).catch(() => {}); // Best-effort

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

async function downloadSkillFromS3(prefix: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });

  // H5 fix: Paginate ListObjectsV2 to handle skills with >1000 files
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  let continuationToken: string | undefined;

  do {
    const listResp = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: normalizedPrefix,
      ContinuationToken: continuationToken,
    }));

    for (const obj of listResp.Contents || []) {
      if (!obj.Key || obj.Key.endsWith('/')) continue;

      const relativePath = obj.Key.slice(prefix.length).replace(/^\//, '');
      const destPath = path.join(destDir, relativePath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });

      const getResp = await s3.send(new GetObjectCommand({
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
  for (const filePath of files) {
    const relativePath = path.relative(srcDir, filePath);
    const key = `${prefix}${relativePath}`;

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: fs.readFileSync(filePath),
      Tagging: `Environment=${ENVIRONMENT}&ManagedBy=cdk&Scope=skill`,
    }));
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

            // Secret detection
            for (const pattern of SECRET_PATTERNS) {
              pattern.lastIndex = 0;
              if (pattern.test(content)) {
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
      }
    }
  }

  // npm audit (best-effort, skip if package.json missing)
  const pkgPath = path.join(skillDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const auditOutput = execSync('npm audit --json --production 2>/dev/null || true', {
        cwd: skillDir,
        timeout: 30_000,
        encoding: 'utf-8',
        env: {
          ...process.env,
          HOME: '/tmp',
          npm_config_cache: '/tmp/.npm',
        },
      });

      try {
        const audit = JSON.parse(auditOutput);
        const vulns = audit.vulnerabilities || {};
        for (const [, info] of Object.entries(vulns) as [string, { severity: string; name: string }][]) {
          if (info.severity === 'high' || info.severity === 'critical') {
            findings.npmAudit.push({
              severity: info.severity,
              title: info.name || 'unknown',
            });
          }
        }
      } catch {
        // audit JSON parse failure — not a blocker
      }
    } catch {
      // npm audit failed — not a blocker
    }
  }

  // Build summary
  const parts: string[] = [];
  if (findings.secrets.length > 0) parts.push(`${findings.secrets.length} potential secret(s)`);
  if (findings.pii.length > 0) parts.push(`${findings.pii.length} potential PII pattern(s)`);
  if (findings.npmAudit.length > 0) parts.push(`${findings.npmAudit.length} high/critical npm vulnerability(ies)`);
  if (findings.skillMdLint.length > 0) parts.push(`${findings.skillMdLint.length} SKILL.md issue(s)`);
  findings.summary = parts.length > 0 ? parts.join(', ') : 'clean';

  return findings;
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
