/**
 * @jest-environment node
 *
 * Regression guard for #1297.
 *
 * `middleware.ts` → `@/auth` → `@/lib/auth/token-refresh-client` is compiled
 * into the Next.js **Edge Runtime sandbox**, which only exposes an allowlist of
 * native modules. Anything on that path that reaches `winston` (via
 * `@/lib/logger`) compiles to a bare `require("winston")` — `winston` is listed
 * in `serverExternalPackages` AND pushed into `config.externals` under
 * `if (isServer)`, which is true for the Edge compiler too — and the sandbox
 * answers with `TypeError: Native module not found: winston`. That killed every
 * token refresh and forced re-authentication.
 *
 * A unit test cannot boot the Edge sandbox, so this walks the *static* import
 * graph from every Edge entrypoint and fails if a Node-only dependency appears
 * on it. It runs in plain CI (`bun run test:ci`) with no build step, so a
 * regression is caught on the PR that introduces it rather than after deploy.
 *
 * NOTE ON DYNAMIC IMPORTS: `await import("…")` with a static specifier is NOT a
 * runtime boundary — the bundler still pulls the target into the importing
 * runtime's chunk. That misconception is what caused this bug, so the walker
 * follows dynamic imports exactly like static ones.
 */

// This guard exists to read first-party source files by computed path — the
// paths are derived from import specifiers inside the repo, never from user
// input, so the non-literal-filename warning does not apply here.
/* eslint-disable security/detect-non-literal-fs-filename */
import { readFileSync, existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const REPO_ROOT = resolve(__dirname, "../../../..")

/**
 * Every entrypoint Next.js compiles for the Edge Runtime, plus the refresh
 * module itself so a failure names the narrowest graph it can.
 *
 * `middleware.ts` is the real entrypoint; `auth.ts` is listed separately
 * because it is where the NextAuth callbacks live and where a Node-only import
 * is most likely to be added by someone who has not read this file.
 */
const ENTRIES = ["middleware.ts", "auth.ts", "lib/auth/token-refresh-client.ts"]

/**
 * Specifiers that cannot exist anywhere on an Edge path.
 * `@/lib/logger` is the winston-backed Node logger; `@/lib/auth/edge-logger`
 * is its Edge-safe counterpart and is what these paths must use.
 *
 * Patterns accept both path aliases from tsconfig.json (`@/*` and `~/*`).
 */
const FORBIDDEN = [
  { pattern: /^winston$/, why: "winston is a Node-only native module; the Edge sandbox rejects it" },
  {
    pattern: /^[@~]\/lib\/logger$/,
    why: "@/lib/logger imports winston — use @/lib/auth/edge-logger on Edge paths",
  },
  { pattern: /^@aws-sdk\//, why: "the AWS SDK is not Edge-safe here; use fetch" },
  { pattern: /^node:/, why: "node: builtins are unavailable in the Edge sandbox" },
  {
    pattern: /^[@~]\/actions\//,
    why: 'importing a "use server" action from Edge code inlines it into the Edge bundle rather than crossing into Node (#1297)',
  },
]

/**
 * Edges that reach Node-only code but are provably never *evaluated* on Edge,
 * because the importing site returns early behind an `EdgeRuntime` check.
 *
 * These are allowed, but not on trust: `guard` must still be present in the
 * importing file, and the "guard is still in place" test below fails if it is
 * removed. Without that pairing, deleting one line would silently reintroduce
 * #1297 while this suite stayed green.
 *
 * Do not add entries here to silence a violation. The correct fix for new code
 * is to not reach Node-only modules from Edge at all.
 */
const GUARDED_EDGES = [
  {
    file: "auth.ts",
    specifier: "@/lib/auth/agent-token-sync",
    guard: /EdgeRuntime\b[\s\S]{0,120}?!==\s*["']undefined["']\s*\)\s*return/,
    why: "best-effort Secrets Manager mirror; skipped outright on Edge (#1297)",
  },
]

const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"]

/** Remove comments so documentation that *names* a forbidden module is not flagged. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

// Deliberately simple, linear-time patterns — no lazy `[\s\S]*?` spans, which
// backtrack badly on large files.
const FROM_CLAUSE = /\bfrom\s*["']([^"']+)["']/g
const OTHER_SPECIFIERS = [
  /\bimport\s+["']([^"']+)["']/g, // side-effect import
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, // dynamic import — still bundled
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
]

/**
 * True when the `from "…"` clause ending at `index` belongs to an
 * `import type` / `export type` statement. Those are erased by the compiler and
 * never reach the bundle.
 */
function isTypeOnlyClause(code: string, index: number): boolean {
  const preceding = code.slice(Math.max(0, index - 500), index)
  const keywordAt = Math.max(preceding.lastIndexOf("import"), preceding.lastIndexOf("export"))
  if (keywordAt === -1) return false
  return /^(?:import|export)\s+type\b/.test(preceding.slice(keywordAt))
}

/**
 * True for `typeof import("…")`, a type-level query that is fully erased.
 * `lib/auth/agent-token-sync.ts` uses it to type an SDK client without loading it.
 */
function isTypeQuery(code: string, index: number): boolean {
  return /\btypeof\s*$/.test(code.slice(Math.max(0, index - 12), index))
}

/** Extract every module specifier that survives compilation. */
function extractSpecifiers(source: string): string[] {
  const code = stripComments(source)
  const found = new Set<string>()

  FROM_CLAUSE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FROM_CLAUSE.exec(code)) !== null) {
    if (isTypeOnlyClause(code, match.index)) continue
    found.add(match[1])
  }

  for (const pattern of OTHER_SPECIFIERS) {
    pattern.lastIndex = 0
    while ((match = pattern.exec(code)) !== null) {
      if (isTypeQuery(code, match.index)) continue
      found.add(match[1])
    }
  }

  return [...found]
}

/**
 * Resolve a first-party specifier to a file on disk, or null for externals.
 * Handles both tsconfig path aliases (`@/*` and `~/*`) plus relative imports.
 */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  let base: string
  if (specifier.startsWith("@/") || specifier.startsWith("~/")) {
    base = join(REPO_ROOT, specifier.slice(2))
  } else if (specifier.startsWith(".")) {
    base = resolve(dirname(fromFile), specifier)
  } else {
    return null // node_modules — not walked, only checked against FORBIDDEN
  }

  for (const ext of EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext
  }
  for (const ext of EXTENSIONS) {
    const indexFile = join(base, `index${ext}`)
    if (existsSync(indexFile)) return indexFile
  }
  return existsSync(base) ? base : null
}

interface Violation {
  file: string
  specifier: string
  why: string
  chain: string[]
}

const rel = (absolute: string): string => absolute.replace(`${REPO_ROOT}/`, "")

/** Breadth-first walk of the first-party import graph rooted at `entry`. */
function walkGraph(entry: string): { visited: Set<string>; violations: Violation[] } {
  const visited = new Set<string>()
  const violations: Violation[] = []
  const queue: Array<{ file: string; chain: string[] }> = [
    { file: join(REPO_ROOT, entry), chain: [entry] },
  ]

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!
    if (visited.has(file)) continue
    visited.add(file)

    if (!existsSync(file)) continue
    const specifiers = extractSpecifiers(readFileSync(file, "utf8"))
    const fileRel = rel(file)

    for (const specifier of specifiers) {
      // A guarded edge is neither reported nor followed — the whole subgraph
      // behind it is unreachable at runtime on Edge.
      if (GUARDED_EDGES.some((e) => e.file === fileRel && e.specifier === specifier)) continue

      const forbidden = FORBIDDEN.find((f) => f.pattern.test(specifier))
      if (forbidden) {
        violations.push({ file: fileRel, specifier, why: forbidden.why, chain })
      }

      const resolved = resolveSpecifier(specifier, file)
      if (resolved && !visited.has(resolved)) {
        queue.push({ file: resolved, chain: [...chain, rel(resolved)] })
      }
    }
  }

  return { visited, violations }
}

describe("Edge auth graph stays free of Node-only dependencies (#1297)", () => {
  it.each(ENTRIES)("reaches no forbidden module from %s", (entry) => {
    expect(existsSync(join(REPO_ROOT, entry))).toBe(true)

    const { violations } = walkGraph(entry)

    const report = violations
      .map((v) => `  ${v.file} imports "${v.specifier}" — ${v.why}\n    via: ${v.chain.join(" → ")}`)
      .join("\n")
    expect(report).toBe("")
  })

  it("actually walks the refresh path rather than passing vacuously", () => {
    // Named files, not a count: a rename or a resolution failure would otherwise
    // shrink the walk to nothing and the suite would still be green.
    const { visited } = walkGraph("middleware.ts")
    const walked = [...visited].map(rel)

    expect(walked).toEqual(
      expect.arrayContaining([
        "middleware.ts",
        "auth.ts",
        "lib/auth/token-refresh-client.ts",
        "lib/auth/cognito-refresh.ts",
        "lib/auth/edge-logger.ts",
      ]),
    )
  })

  it.each(GUARDED_EDGES)(
    "keeps the EdgeRuntime guard that makes $file → $specifier safe",
    ({ file, specifier, guard }) => {
      const source = readFileSync(join(REPO_ROOT, file), "utf8")

      // If the import is gone entirely the edge is simply no longer a concern.
      if (!source.includes(specifier)) return

      // Removing the guard turns a lazily-imported Node module into one the Edge
      // sandbox will try to load — exactly #1297. Allowlisting the edge is only
      // sound while the guard is there.
      expect(source).toMatch(guard)
    },
  )

  it("detects a forbidden import when one is present (guard self-test)", () => {
    // Proves the walker inspects file contents rather than passing by accident:
    // lib/logger.ts is the canonical winston importer.
    const { violations } = walkGraph("lib/logger.ts")
    expect(violations.some((v) => v.specifier === "winston")).toBe(true)
  })

  it("would flag the reverted #1297 import", () => {
    // The original bug was `await import("@/actions/auth/refresh-token-action")`
    // from Edge code. Pin that the FORBIDDEN list still covers it.
    expect(
      FORBIDDEN.some((f) => f.pattern.test("@/actions/auth/refresh-token-action")),
    ).toBe(true)
    expect(FORBIDDEN.some((f) => f.pattern.test("~/lib/logger"))).toBe(true)
  })
})
