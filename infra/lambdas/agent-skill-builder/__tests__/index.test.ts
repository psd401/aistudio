/**
 * Tests for agent-skill-builder security hardening (B-002):
 *   REV-INFRA-061 — npm install must run with lifecycle scripts DISABLED (RCE).
 *   REV-INFRA-062 — dependency audit runs post-install and gates promotion.
 *   REV-INFRA-063 — S3 download rejects path-traversing keys (zip-slip).
 *
 * Run from infra/lambdas/agent-skill-builder/:  bun test
 *
 * Placed under __tests__/ so the lambda's `tsc` build (tsconfig include:
 * ["*.ts"], non-recursive) does not compile it; bun test discovers it directly
 * and strips the type-only `aws-lambda` import at runtime.
 */

import { test, expect, describe } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';

import {
  installSkillDependencies,
  auditInstalledDeps,
  downloadSkillFromS3,
} from '../index';

type Warn = { message: string; meta?: Record<string, unknown> };
function collectingLogger(warnings: Warn[]) {
  return {
    info: () => {},
    warn: (message: string, meta?: Record<string, unknown>) => warnings.push({ message, meta }),
    error: () => {},
  };
}

function makeSkillDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skillbuild-'));
}

// A postinstall that writes a sentinel file into the package cwd. If it runs,
// the sentinel exists — i.e. arbitrary code executed during the build.
const MALICIOUS_PKG = JSON.stringify({
  name: 'evil-skill',
  version: '1.0.0',
  scripts: { postinstall: "node -e \"require('fs').writeFileSync('PWNED','x')\"" },
});

describe('installSkillDependencies (REV-INFRA-061)', () => {
  test('does NOT execute a malicious postinstall lifecycle script', () => {
    const dir = makeSkillDir();
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), MALICIOUS_PKG);
      installSkillDependencies(dir);
      expect(fs.existsSync(path.join(dir, 'PWNED'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('control: the same postinstall DOES run without --ignore-scripts (fixture is valid)', () => {
    const dir = makeSkillDir();
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), MALICIOUS_PKG);
      execSync('npm install --production --no-audit --no-fund', {
        cwd: dir,
        stdio: 'pipe',
        env: { ...process.env, HOME: '/tmp', npm_config_cache: '/tmp/.npm' },
      });
      expect(fs.existsSync(path.join(dir, 'PWNED'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a benign skill (no scripts, no deps) installs without error', () => {
    const dir = makeSkillDir();
    try {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'good-skill', version: '1.0.0' }),
      );
      expect(() => installSkillDependencies(dir)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('auditInstalledDeps (REV-INFRA-062)', () => {
  test('returns high/critical advisories parsed from audit JSON', () => {
    const warnings: Warn[] = [];
    const fakeExec = () =>
      JSON.stringify({
        vulnerabilities: {
          lodash: { severity: 'high', name: 'lodash' },
          ms: { severity: 'critical', name: 'ms' },
          chalk: { severity: 'low', name: 'chalk' }, // below threshold — ignored
        },
      });
    const out = auditInstalledDeps('/work', collectingLogger(warnings), fakeExec);
    expect(out.map((o) => o.severity).sort()).toEqual(['critical', 'high']);
    expect(warnings.length).toBe(0);
  });

  test('a clean dependency tree yields no advisories', () => {
    const fakeExec = () => JSON.stringify({ vulnerabilities: {} });
    expect(auditInstalledDeps('/work', collectingLogger([]), fakeExec)).toEqual([]);
  });

  test('unparseable audit output degrades gracefully with a WARNING (never a silent pass)', () => {
    const warnings: Warn[] = [];
    const fakeExec = () => 'npm error code ENOLOCK\nThis is not JSON';
    const out = auditInstalledDeps('/work', collectingLogger(warnings), fakeExec);
    expect(out).toEqual([]);
    expect(warnings.some((w) => /not evaluated/i.test(w.message))).toBe(true);
  });

  test('audit tooling throwing (no stdout) degrades gracefully with a WARNING', () => {
    const warnings: Warn[] = [];
    const fakeExec = () => {
      throw new Error('spawn npm ENOENT');
    };
    const out = auditInstalledDeps('/work', collectingLogger(warnings), fakeExec);
    expect(out).toEqual([]);
    expect(warnings.some((w) => /not evaluated/i.test(w.message))).toBe(true);
  });

  test('npm audit exiting non-zero for real vulnerabilities still parses stdout from the thrown error', () => {
    const warnings: Warn[] = [];
    const fakeExec = () => {
      const err = new Error('Command failed') as Error & { stdout: string };
      err.stdout = JSON.stringify({
        vulnerabilities: { minimist: { severity: 'critical', name: 'minimist' } },
      });
      throw err;
    };
    const out = auditInstalledDeps('/work', collectingLogger(warnings), fakeExec);
    expect(out).toEqual([{ severity: 'critical', title: 'minimist' }]);
    expect(warnings.length).toBe(0);
  });

  test('a top-level `error` field (registry/auth failure) degrades gracefully with a WARNING, never a silent clean', () => {
    const warnings: Warn[] = [];
    const fakeExec = () => JSON.stringify({ error: { code: 'E401', summary: 'unauthorized' } });
    const out = auditInstalledDeps('/work', collectingLogger(warnings), fakeExec);
    expect(out).toEqual([]);
    expect(warnings.some((w) => /not evaluated/i.test(w.message))).toBe(true);
  });
});

describe('downloadSkillFromS3 path-traversal guard (REV-INFRA-063)', () => {
  function fakeS3(keys: string[], getCalls: string[]) {
    return {
      send: async (cmd: { constructor: { name: string }; input?: { Key?: string } }) => {
        const name = cmd.constructor.name;
        if (name === 'ListObjectsV2Command') {
          return { Contents: keys.map((Key) => ({ Key })), NextContinuationToken: undefined };
        }
        if (name === 'GetObjectCommand') {
          getCalls.push(cmd.input?.Key ?? '');
          async function* body() {
            yield Buffer.from('file-content');
          }
          return { Body: body() };
        }
        throw new Error(`unexpected command ${name}`);
      },
    };
  }

  test('skips traversing keys, downloads only in-root keys, and warns', async () => {
    const destDir = makeSkillDir();
    const warnings: Warn[] = [];
    const getCalls: string[] = [];
    const prefix = 'drafts/skill-1/';
    const keys = [
      `${prefix}src/index.js`, // benign nested
      `${prefix}../../evil.txt`, // zip-slip escape (resolves outside destDir)
      `${prefix}ok.md`, // benign top-level
    ];
    try {
      await downloadSkillFromS3(
        prefix,
        destDir,
        collectingLogger(warnings),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fakeS3(keys, getCalls) as any,
      );

      // benign files were written to the correct relative paths
      expect(fs.existsSync(path.join(destDir, 'src', 'index.js'))).toBe(true);
      expect(fs.existsSync(path.join(destDir, 'ok.md'))).toBe(true);
      // the escaping object was never fetched or written
      expect(getCalls).toEqual([`${prefix}src/index.js`, `${prefix}ok.md`]);
      expect(fs.existsSync(path.resolve(destDir, '..', '..', 'evil.txt'))).toBe(false);
      // and it was logged
      expect(
        warnings.some((w) => String(w.meta?.key ?? '').includes('../../evil.txt')),
      ).toBe(true);
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  });

  test('normal nested keys still download to the correct relative path', async () => {
    const destDir = makeSkillDir();
    const getCalls: string[] = [];
    const prefix = 'drafts/skill-2/';
    const keys = [`${prefix}a/b/c.ts`];
    try {
      await downloadSkillFromS3(
        prefix,
        destDir,
        collectingLogger([]),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        fakeS3(keys, getCalls) as any,
      );
      expect(fs.existsSync(path.join(destDir, 'a', 'b', 'c.ts'))).toBe(true);
    } finally {
      fs.rmSync(destDir, { recursive: true, force: true });
    }
  });
});
