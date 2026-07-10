/**
 * Policy unit test for infra/policies/mcp-allowlist.json (REV-COR-487).
 *
 * The MCP allowlist is read at runtime (from S3) by AgentCore to gate MCP server
 * endpoints. Its `blockedPatterns` must block the same Student-Information-System
 * host families that the authoritative Cedar policy blocks. The Synergy pattern had
 * drifted to `*synergysis*` (a substring that real Synergy hosts — synergy.<district>,
 * synergy-sis.<...> — never contain), so the SIS block was dead against Synergy while
 * Cedar correctly used `*synergy*`. This test asserts the two agree and that a
 * representative Synergy hostname is blocked.
 */
import * as fs from 'fs';
import * as path from 'path';

const POLICIES_DIR = path.join(__dirname, '..', 'policies');
const allowlist = JSON.parse(
  fs.readFileSync(path.join(POLICIES_DIR, 'mcp-allowlist.json'), 'utf8')
) as { blockedPatterns: string[]; allowedEndpoints: Array<{ url: string }> };
const cedar = fs.readFileSync(
  path.join(POLICIES_DIR, 'cedar', 'psd-agent-governance.cedar'),
  'utf8'
);

// Allowlist/Cedar-style glob: `*` is the only metacharacter and matches any
// sequence (including `/` and `.`), everything else is literal.
function globToRegExp(pattern: string): RegExp {
  const translated = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) =>
    ch === '*' ? '.*' : `\\${ch}`
  );
  return new RegExp(`^${translated}$`);
}

function isBlocked(url: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(url));
}

describe('mcp-allowlist blockedPatterns (REV-COR-487)', () => {
  it('blocks representative Synergy SIS hostnames', () => {
    expect(isBlocked('https://synergy.example.net', allowlist.blockedPatterns)).toBe(true);
    expect(isBlocked('https://synergy-sis.district.org/api', allowlist.blockedPatterns)).toBe(true);
    expect(isBlocked('https://synergy.district.k12.wa.us', allowlist.blockedPatterns)).toBe(true);
  });

  it('still blocks the other SIS families', () => {
    expect(isBlocked('https://ps.powerschool.com', allowlist.blockedPatterns)).toBe(true);
    expect(isBlocked('https://studentvue.district.edu', allowlist.blockedPatterns)).toBe(true);
  });

  it('does not block a legitimate allowlisted endpoint', () => {
    expect(isBlocked('https://sheets.googleapis.com/v4/spreadsheets', allowlist.blockedPatterns)).toBe(
      false
    );
    expect(isBlocked('https://mcp.psd401.net', allowlist.blockedPatterns)).toBe(false);
  });

  it('regression: the old *synergysis* pattern missed real Synergy hosts', () => {
    // Proves why the fix was needed — the previous pattern never matched.
    expect(globToRegExp('*synergysis*').test('https://synergy.example.net')).toBe(false);
    // The corrected pattern must be present.
    expect(allowlist.blockedPatterns).toContain('*synergy*');
    expect(allowlist.blockedPatterns).not.toContain('*synergysis*');
  });

  it('agrees with the authoritative Cedar policy on the blocked SIS families', () => {
    // Both files must block the same host families (Done-when #3).
    for (const family of ['powerschool', 'studentvue', 'synergy']) {
      expect(allowlist.blockedPatterns).toContain(`*${family}*`);
      expect(cedar).toContain(`like "*${family}*"`);
    }
  });
});
