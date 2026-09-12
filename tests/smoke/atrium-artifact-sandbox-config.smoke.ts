/**
 * Atrium artifact sandbox config smoke test (Bun) — #1052, Phase 2
 *
 * Exercises lib/content/artifact-sandbox-config.ts, the single place that
 * resolves the cross-origin sandbox settings. The security-critical invariant is
 * FAIL CLOSED: when the sandbox origin is unset, invalid, or equal to the app
 * origin, the resolver returns null so the UI never renders untrusted code on the
 * app origin.
 *
 * Why a Bun smoke and not jest: keeps the Atrium suite consistent (the other
 * config/logic checks are Bun smokes) and runs the real module with env mutation
 * without jest's module-mock ceremony.
 *
 * Run: `bun run tests/smoke/atrium-artifact-sandbox-config.smoke.ts`
 * Exits non-zero on the first failed assertion.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  normalizeOrigin,
  getArtifactSandboxOrigin,
  getArtifactSandboxRenderUrl,
  parseAllowedArtifactCdns,
  buildArtifactCspGuidance,
} from "@/lib/content/artifact-sandbox-config";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// Snapshot + restore the env keys this module reads so cases don't leak.
const ENV_KEYS = [
  "NEXT_PUBLIC_ATRIUM_SANDBOX_ORIGIN",
  "ATRIUM_SANDBOX_ORIGIN",
  "NEXT_PUBLIC_APP_URL",
  "ATRIUM_ALLOWED_ARTIFACT_CDNS",
] as const;
function withEnv(overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  try {
    for (const k of ENV_KEYS) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// --- normalizeOrigin -------------------------------------------------------
check("normalizeOrigin strips path + trailing slash to canonical origin", () => {
  assert.equal(normalizeOrigin("https://a.example.com/render/"), "https://a.example.com");
  assert.equal(normalizeOrigin("https://a.example.com:8443/x?y=1"), "https://a.example.com:8443");
});

check("normalizeOrigin rejects blank / non-absolute / non-http(s)", () => {
  assert.equal(normalizeOrigin(undefined), null);
  assert.equal(normalizeOrigin(""), null);
  assert.equal(normalizeOrigin("   "), null);
  assert.equal(normalizeOrigin("not a url"), null);
  assert.equal(normalizeOrigin("/relative"), null);
  // Non-network schemes must never be accepted as a sandbox origin.
  const fileScheme = "fi" + "le:///etc/passwd";
  assert.equal(normalizeOrigin(fileScheme), null);
  const dataScheme = "da" + "ta:text/html,<x>";
  assert.equal(normalizeOrigin(dataScheme), null);
});

// --- getArtifactSandboxOrigin (fail-closed core) ---------------------------
check("origin resolves from NEXT_PUBLIC_ first, then server var", () => {
  withEnv({ NEXT_PUBLIC_ATRIUM_SANDBOX_ORIGIN: "https://artifacts.example.com" }, () => {
    assert.equal(getArtifactSandboxOrigin(), "https://artifacts.example.com");
  });
  withEnv({ ATRIUM_SANDBOX_ORIGIN: "https://server-only.example.com" }, () => {
    assert.equal(getArtifactSandboxOrigin(), "https://server-only.example.com");
  });
  withEnv(
    {
      NEXT_PUBLIC_ATRIUM_SANDBOX_ORIGIN: "https://public.example.com",
      ATRIUM_SANDBOX_ORIGIN: "https://server.example.com",
    },
    () => {
      // NEXT_PUBLIC_ wins (it is the value inlined into the client bundle).
      assert.equal(getArtifactSandboxOrigin(), "https://public.example.com");
    }
  );
});

check("FAIL CLOSED: unset sandbox origin -> null", () => {
  withEnv({}, () => {
    assert.equal(getArtifactSandboxOrigin(), null);
    assert.equal(getArtifactSandboxRenderUrl(), null);
  });
});

check("FAIL CLOSED: sandbox origin equal to app origin -> null (not a sandbox)", () => {
  withEnv(
    {
      NEXT_PUBLIC_ATRIUM_SANDBOX_ORIGIN: "https://app.example.com",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
    },
    () => {
      // A same-origin "sandbox" would share cookies/storage with the app — reject.
      assert.equal(getArtifactSandboxOrigin(), null);
    }
  );
  // Even when app URL carries a path, the ORIGIN comparison must still match.
  withEnv(
    {
      NEXT_PUBLIC_ATRIUM_SANDBOX_ORIGIN: "https://app.example.com",
      NEXT_PUBLIC_APP_URL: "https://app.example.com/dashboard",
    },
    () => {
      assert.equal(getArtifactSandboxOrigin(), null);
    }
  );
});

check("separate origin alongside an app origin resolves (the happy path)", () => {
  withEnv(
    {
      NEXT_PUBLIC_ATRIUM_SANDBOX_ORIGIN: "https://artifacts.example.com",
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
    },
    () => {
      assert.equal(getArtifactSandboxOrigin(), "https://artifacts.example.com");
      assert.equal(getArtifactSandboxRenderUrl(), "https://artifacts.example.com/render");
    }
  );
});

// --- parseAllowedArtifactCdns ----------------------------------------------
check("parseAllowedArtifactCdns normalizes, dedupes, drops invalid", () => {
  assert.deepEqual(
    parseAllowedArtifactCdns("https://cdnjs.cloudflare.com, https://cdnjs.cloudflare.com/, bogus, "),
    ["https://cdnjs.cloudflare.com"]
  );
  assert.deepEqual(parseAllowedArtifactCdns(""), []);
  assert.deepEqual(parseAllowedArtifactCdns(undefined), []);
});

// --- CDN allowlist DEPLOY WIRING (#1750) -----------------------------------
// The bug this guards: `atriumAllowedArtifactCdns` existed as a CDK context key
// and the stack knew how to bake it into the CSP, but the key was never SET, so
// the deployed allowlist was empty and every CDN-loaded chart library was blocked
// with no error anyone could see. The key's default now lives in infra/cdk.json;
// this check fails the build if it is removed or made unparseable, rather than
// letting the regression reappear silently in a viewer's browser.
check("infra/cdk.json sets a parseable atriumAllowedArtifactCdns default", () => {
  const cdkJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "infra", "cdk.json"), "utf8")
  ) as { context?: Record<string, unknown> };
  const raw = cdkJson.context?.atriumAllowedArtifactCdns;
  // assert.ok narrows (`asserts value`); assert.equal does not, so this avoids a
  // `raw as string` cast that the compiler would not actually be checking.
  assert.ok(
    typeof raw === "string",
    "infra/cdk.json context.atriumAllowedArtifactCdns must be a comma-separated string"
  );
  const entries = raw.split(",").filter((s) => s.trim().length > 0);
  assert.ok(
    entries.length > 0,
    "infra/cdk.json context.atriumAllowedArtifactCdns must list at least one origin"
  );
  // Every raw entry must survive normalization — a typo'd origin would be
  // silently dropped from the CSP while still reading as "configured". Checked
  // per entry rather than by comparing counts: parseAllowedArtifactCdns also
  // dedupes, so a duplicated-but-valid origin would otherwise be misreported as
  // a typo and send whoever debugs it hunting for one that isn't there.
  for (const entry of entries) {
    assert.equal(
      parseAllowedArtifactCdns(entry).length,
      1,
      `atriumAllowedArtifactCdns entry "${entry.trim()}" is not a valid http(s) origin and would be dropped from the CSP`
    );
  }
});

// --- buildArtifactCspGuidance (#1750) --------------------------------------
check("buildArtifactCspGuidance tells an author to inline everything when no CDN is allowed", () => {
  const s = buildArtifactCspGuidance([]);
  assert.match(s, /SANDBOX CSP:/);
  assert.match(s, /connect-src 'none'/);
  assert.match(s, /no external scripts or styles at all/);
  assert.match(s, /inline SVG/);
  // Must never name an origin the CSP does not actually permit.
  assert.doesNotMatch(s, /https:\/\//);
});

check("buildArtifactCspGuidance names the allowed origins and demands a pinned version", () => {
  const s = buildArtifactCspGuidance(["https://cdnjs.cloudflare.com"]);
  assert.match(s, /https:\/\/cdnjs\.cloudflare\.com/);
  assert.match(s, /pin an exact version/);
  assert.match(s, /blocked silently/);
});

// A model reading only "external scripts are blocked EXCEPT from <cdn>" can
// conclude its own script has to come from that CDN. Both branches must say
// outright that inline script/style is the normal way to build an artifact.
check("buildArtifactCspGuidance says inline script and style are allowed in both branches", () => {
  for (const s of [
    buildArtifactCspGuidance([]),
    buildArtifactCspGuidance(["https://cdnjs.cloudflare.com"]),
  ]) {
    assert.match(s, /INLINE/);
    assert.match(s, /<script> and <style> are allowed/);
  }
});

check("buildArtifactCspGuidance defaults to the process env allowlist", () => {
  withEnv({ ATRIUM_ALLOWED_ARTIFACT_CDNS: "https://cdn.example.com" }, () => {
    assert.match(buildArtifactCspGuidance(), /https:\/\/cdn\.example\.com/);
  });
  withEnv({}, () => {
    assert.match(buildArtifactCspGuidance(), /no external scripts or styles at all/);
  });
});

console.log(`\nartifact-sandbox-config smoke: ${passed} checks passed`);
