/**
 * Drift guard: agent-skill CDN prose vs. the deployed sandbox allowlist (#1750).
 *
 * The artifact sandbox CSP permits `<script src>` / `<link href>` only from the
 * origins in the `atriumAllowedArtifactCdns` CDK context key. The app renders its
 * authoring guidance from that same key, so those two can never disagree.
 *
 * The agent skills cannot: they are static prose baked into the agent image,
 * which is built and deployed separately from the app. If the key changes and the
 * skills do not, a skill confidently tells a model to load a library from an
 * origin the CSP then drops SILENTLY — the page renders, the feature is dead,
 * nothing errors. That is exactly the failure #1750 fixed, relocated into a
 * surface with no automated link to the source of truth.
 *
 * This test is that link. It is deliberately built on exact string matching, not
 * on reading intent out of prose: the sets below are the whole policy, and a new
 * host in a skill fails until a human puts it in one of them.
 *
 * Host detection is DEFAULT-DENY. Every absolute URL in the guidance is extracted
 * and its host must be classified — allowlisted, documented-as-blocked, or an
 * explicitly-declared non-asset reference link. A shortlist of known CDN hosts
 * cannot work here: the drift this guards against is a skill naming an origin
 * nobody predicted, and a host absent from a predetermined list would sail
 * through the very check meant to catch it.
 */
/* eslint-disable security/detect-non-literal-fs-filename --
 * Every path here is derived by walking a fixed in-repo directory joined against
 * __dirname. Nothing in this file reads a caller-, model-, or network-supplied
 * path.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const INFRA_ROOT = path.join(__dirname, '..');
const SKILLS_DIR = path.join(INFRA_ROOT, 'agent-image', 'skills');

/**
 * Hosts a model would plausibly reach for to load a script or stylesheet.
 *
 * This list is NOT the detection mechanism — host extraction below is
 * default-deny and catches hosts nobody thought to list. These are checked
 * additionally, because they are flagged even when named as a bare host with no
 * scheme ("just use unpkg.com"), which the URL extractor does not see.
 *
 * Only hosts spelled as real domains are listed. Prose that names a CDN without a
 * domain ("load GSAP from a CDN", "jsDelivr, unpkg, esm.sh ... is blocked") is not
 * an instruction a model can follow to a specific origin and is not matched here.
 */
const SCRIPT_STYLE_CDN_HOSTS = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'unpkg.com',
  'esm.sh',
  'code.jquery.com',
  'cdn.skypack.dev',
  'stackpath.bootstrapcdn.com',
  'maxcdn.bootstrapcdn.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'ajax.googleapis.com',
];

/**
 * Hosts the skills name on purpose as BLOCKED, to steer a model away from them.
 *
 * These must NOT be in the allowlist — they are counter-examples. Google Fonts is
 * here because `font-src` is a hardcoded `font-src data:` that the CDN allowlist
 * never widens, so a webfont `<link>` always fails silently and the skills say so.
 *
 * Adding a host here is a deliberate statement that the skills present it as
 * unusable. If you instead want a host to become loadable, add it to
 * `atriumAllowedArtifactCdns` in infra/cdk.json and update the skill prose.
 */
const DOCUMENTED_AS_BLOCKED = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  // data-viz.md lists "jsDelivr, unpkg, esm.sh" as origins that are blocked
  // silently. The other two are prose without a TLD and never match; `esm.sh`
  // happens to BE its own domain, so it matches and has to be declared here.
  'esm.sh',
];

/**
 * Hosts the guidance links to for reasons that are NOT loading a script or
 * stylesheet into a sandboxed artifact: documentation, PSD's own apps, API
 * endpoints a skill calls server-side, and RFC-2606 example domains.
 *
 * This is the escape hatch that makes default-deny livable. Adding a host here is
 * a deliberate statement that no model will ever put it in a `<script src>` or
 * `<link href>`. If a host IS meant to be loadable from a sandboxed page, it
 * belongs in `atriumAllowedArtifactCdns` in infra/cdk.json instead.
 *
 * An entry starting with `.` matches by domain suffix.
 */
const NON_ASSET_REFERENCE_HOSTS = [
  // PSD's own properties
  'psd401.ai',
  'aistudio.psd401.ai',
  'dev.aistudio.psd401.ai',
  'psd401.freshservice.com',
  // Per-environment S3 buckets holding generated media, linked as output URLs
  '.s3.us-east-1.amazonaws.com',
  // Vendor docs / consoles / APIs a skill calls or cites
  'cruciallearning.com',
  'hyperframes.heygen.com',
  'mcp.plaud.ai',
  'api.canva.com',
  'github.com',
  'api.github.com',
  'docs.google.com',
  'accounts.google.com',
  'developers.google.com',
  // The Google Fonts *browser* — a human-facing catalogue page, not the
  // stylesheet host. `fonts.googleapis.com` is the loadable one and stays in
  // DOCUMENTED_AS_BLOCKED above.
  'fonts.google.com',
  // Spec namespace in `<svg xmlns=...>` — never fetched
  'www.w3.org',
  // RFC 2606 placeholders in examples
  'example.com',
  'example.org',
];

/** Guidance surfaces shipped to a model. Skill test/source files are not prose. */
const GUIDANCE_EXTENSIONS = ['.md', '.html'];

/** Absolute URLs in prose, markdown links, or HTML attributes. */
const ABSOLUTE_URL_HOST = /https?:\/\/([A-Za-z0-9._-]+)/g;

/**
 * Hosts named in a chunk of guidance.
 *
 * Trailing separators are trimmed, and anything without a plausible TLD is
 * dropped: a placeholder like `https://psd-agents-dev-…​.s3.amazonaws.com` is
 * truncated by the extractor at the ellipsis, and a bare fragment is not an
 * origin a model can load from.
 */
function extractHosts(contents: string): string[] {
  const hosts = new Set<string>();
  for (const match of contents.matchAll(ABSOLUTE_URL_HOST)) {
    const host = match[1].replace(/[.-]+$/, '').toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host)) continue;
    hosts.add(host);
  }
  return [...hosts];
}

function isDeclaredNonAsset(host: string): boolean {
  return NON_ASSET_REFERENCE_HOSTS.some((entry) =>
    entry.startsWith('.') ? host.endsWith(entry) : host === entry
  );
}

function readAllowedArtifactCdns(): string[] {
  const cdkJson = JSON.parse(
    fs.readFileSync(path.join(INFRA_ROOT, 'cdk.json'), 'utf8')
  ) as { context?: Record<string, unknown> };
  const raw = cdkJson.context?.atriumAllowedArtifactCdns;
  if (typeof raw !== 'string') {
    throw new TypeError(
      'infra/cdk.json context.atriumAllowedArtifactCdns must be a comma-separated string'
    );
  }
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function collectGuidanceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collectGuidanceFiles(full, found);
    } else if (GUIDANCE_EXTENSIONS.includes(path.extname(entry.name))) {
      found.push(full);
    }
  }
  return found;
}

describe('agent skill CDN prose tracks the sandbox allowlist (#1750)', () => {
  const allowedOrigins = readAllowedArtifactCdns();
  const allowedHosts = allowedOrigins.map((origin) => new URL(origin).host);
  const guidanceFiles = collectGuidanceFiles(SKILLS_DIR);

  it('finds skill guidance to check (guards against a moved skills directory)', () => {
    expect(guidanceFiles.length).toBeGreaterThan(0);
    expect(allowedOrigins.length).toBeGreaterThan(0);
  });

  // Detection is now dynamic, so a regex that quietly stops matching would turn
  // the whole gate green forever. Pin the extractor against known-good input and
  // against the real corpus.
  it('extracts hosts from the guidance it reads', () => {
    expect(
      extractHosts(
        'see <https://cdn.example-a.net/x.js>, `https://cdn.example-b.org`, ' +
          'and a truncated https://psd-agents-dev-… placeholder'
      ).sort()
    ).toEqual(['cdn.example-a.net', 'cdn.example-b.org']);

    const corpusHosts = new Set(
      guidanceFiles.flatMap((file) => extractHosts(fs.readFileSync(file, 'utf8')))
    );
    expect(corpusHosts.size).toBeGreaterThan(0);
    for (const host of allowedHosts) {
      expect(corpusHosts).toContain(host);
    }
  });

  // Direction 1: a CDN was added to / changed in the allowlist, but no skill says
  // so. The models keep inlining everything and the new capability goes unused.
  it('names every allowlisted origin somewhere in the skills', () => {
    const corpus = guidanceFiles
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');

    // The full origin, scheme included — a model has to be able to copy it into
    // a `<script src>`. A bare host somewhere in the prose is not enough.
    const undocumented = allowedOrigins
      .filter((origin) => !corpus.includes(origin))
      .map(
        (origin) =>
          `${origin} is allowlisted in infra/cdk.json but no skill names it. ` +
          'Add it to the skill guidance (psd-atrium/SKILL.md and ' +
          'psd-html-artifact) and rebuild the agent image, or drop it from ' +
          'atriumAllowedArtifactCdns.'
      );

    expect(undocumented).toEqual([]);
  });

  // Direction 2 — the dangerous one: a skill points a model at a CDN host that is
  // NOT allowlisted, so the script it writes is dropped silently. Either the host
  // belongs in infra/cdk.json, or the skill is naming it as a counter-example and
  // it belongs in DOCUMENTED_AS_BLOCKED.
  it('points models only at hosts the CSP actually permits', () => {
    const offenders: string[] = [];

    for (const file of guidanceFiles) {
      const contents = fs.readFileSync(file, 'utf8');
      const where = path.relative(INFRA_ROOT, file);

      // Default-deny: every host the guidance spells as a URL must be
      // classified. An origin nobody predicted is the whole point of the gate.
      const urlHosts = extractHosts(contents);
      for (const host of urlHosts) {
        if (allowedHosts.includes(host)) continue;
        if (DOCUMENTED_AS_BLOCKED.includes(host)) continue;
        if (isDeclaredNonAsset(host)) continue;
        offenders.push(
          `${where} links to https://${host}, which the sandbox CSP does not ` +
            'permit — a script or stylesheet loaded from it is dropped ' +
            'silently. Pick one: add it to atriumAllowedArtifactCdns in ' +
            'infra/cdk.json (it should be loadable), add it to ' +
            'DOCUMENTED_AS_BLOCKED (the skill names it as a counter-example), ' +
            'or add it to NON_ASSET_REFERENCE_HOSTS (it is a documentation or ' +
            'API link no model will put in a <script src>).'
        );
      }

      // Bare hosts with no scheme ("just use unpkg.com") are invisible to the
      // URL extractor but still steer a model at a blocked origin.
      for (const host of SCRIPT_STYLE_CDN_HOSTS) {
        if (!contents.includes(host)) continue;
        if (allowedHosts.includes(host)) continue;
        if (DOCUMENTED_AS_BLOCKED.includes(host)) continue;
        // Already reported above, with a message that fits it better.
        if (urlHosts.includes(host)) continue;
        offenders.push(
          `${where} names ${host}, which the sandbox CSP does not permit — a ` +
            'script loaded from it is dropped silently. Either add it to ' +
            'atriumAllowedArtifactCdns in infra/cdk.json, or, if the skill ' +
            'names it as a counter-example, add it to DOCUMENTED_AS_BLOCKED ' +
            'in this test.'
        );
      }
    }

    expect([...new Set(offenders)]).toEqual([]);
  });

  // The two sets must stay disjoint: a host cannot be both loadable and taught as
  // blocked. This is the check that fires if someone allowlists Google Fonts
  // without also removing the "it always fails silently" prose.
  it('keeps the allowlist and the documented-as-blocked set disjoint', () => {
    const both = allowedHosts
      .filter((host) => DOCUMENTED_AS_BLOCKED.includes(host))
      .map(
        (host) =>
          `${host} is both allowlisted and taught as blocked. Remove it from ` +
          'DOCUMENTED_AS_BLOCKED in this test AND update the skill prose that ' +
          'tells authors it fails, or drop it from atriumAllowedArtifactCdns.'
      );

    expect(both).toEqual([]);
  });

  // NON_ASSET_REFERENCE_HOSTS exempts a host from the default-deny sweep, so it
  // must not become a back door for silencing a real CDN.
  it('never exempts a known script/style CDN as a mere reference link', () => {
    const smuggled = SCRIPT_STYLE_CDN_HOSTS.filter(isDeclaredNonAsset).map(
      (host) =>
        `${host} is a known script/style CDN but sits in ` +
        'NON_ASSET_REFERENCE_HOSTS, which would exempt it from the sweep. ' +
        'Put it in atriumAllowedArtifactCdns or DOCUMENTED_AS_BLOCKED instead.'
    );

    expect(smuggled).toEqual([]);
  });
});
