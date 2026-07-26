/**
 * @jest-environment node
 *
 * Regression guard for #1297.
 *
 * `middleware.ts` → `@/auth` → `@/lib/auth/token-refresh-client` is compiled
 * into the Next.js **Edge Runtime sandbox**, which only exposes an allowlist of
 * native modules. Anything on that path that reaches `winston` (via
 * `@/lib/logger`) compiles to a bare `require("winston")` — `winston` is listed
 * in `serverExternalPackages` — and the sandbox answers with
 * `TypeError: Native module not found: winston`, which killed every token
 * refresh and forced re-authentication.
 *
 * A unit test cannot boot the Edge sandbox, so this walks the *static* import
 * graph of the refresh path and fails if a Node-only dependency ever reappears
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

/** The entrypoint the Edge middleware graph reaches for token refresh. */
const ENTRY = "lib/auth/token-refresh-client.ts"

/**
 * Specifiers that cannot exist anywhere on the refresh path.
 * `@/lib/logger` is the winston-backed Node logger; `@/lib/auth/edge-logger`
 * is its Edge-safe counterpart and is what this path must use.
 */
const FORBIDDEN = [
  { pattern: /^winston$/, why: "winston is a Node-only native module; the Edge sandbox rejects it" },
  {
    pattern: /^@\/lib\/logger$/,
    why: "@/lib/logger imports winston — use @/lib/auth/edge-logger on Edge paths",
  },
  { pattern: /^@aws-sdk\//, why: "the AWS SDK is not Edge-safe here; use fetch" },
  { pattern: /^node:/, why: "node: builtins are unavailable in the Edge sandbox" },
  {
    pattern: /^@\/actions\//,
    why: 'importing a "use server" action from Edge code inlines it into the Edge bundle rather than crossing into Node (#1297)',
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
 * never reach the bundle, so they are not boundary violations.
 */
function isTypeOnlyClause(code: string, index: number): boolean {
  const preceding = code.slice(Math.max(0, index - 500), index)
  const keywordAt = Math.max(preceding.lastIndexOf("import"), preceding.lastIndexOf("export"))
  if (keywordAt === -1) return false
  return /^(?:import|export)\s+type\b/.test(preceding.slice(keywordAt))
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
      found.add(match[1])
    }
  }

  return [...found]
}

/** Resolve a first-party specifier to a file on disk, or null for externals. */
function resolveSpecifier(specifier: string, fromFile: string): string | null {
  let base: string
  if (specifier.startsWith("@/")) {
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

    for (const specifier of specifiers) {
      const forbidden = FORBIDDEN.find((f) => f.pattern.test(specifier))
      if (forbidden) {
        violations.push({
          file: file.replace(`${REPO_ROOT}/`, ""),
          specifier,
          why: forbidden.why,
          chain,
        })
      }

      const resolved = resolveSpecifier(specifier, file)
      if (resolved && !visited.has(resolved)) {
        queue.push({ file: resolved, chain: [...chain, resolved.replace(`${REPO_ROOT}/`, "")] })
      }
    }
  }

  return { visited, violations }
}

describe("Edge refresh path stays free of Node-only dependencies (#1297)", () => {
  it("has an entrypoint to walk", () => {
    expect(existsSync(join(REPO_ROOT, ENTRY))).toBe(true)
  })

  it("reaches no forbidden module from the refresh entrypoint", () => {
    const { visited, violations } = walkGraph(ENTRY)

    // Guard the guard: if resolution silently broke, the walk would visit one
    // file, find nothing, and pass vacuously.
    expect(visited.size).toBeGreaterThan(1)

    const report = violations
      .map((v) => `  ${v.file} imports "${v.specifier}" — ${v.why}\n    via: ${v.chain.join(" → ")}`)
      .join("\n")
    expect(report).toBe("")
  })

  it("still routes its logging through the Edge-safe logger", () => {
    const source = readFileSync(join(REPO_ROOT, ENTRY), "utf8")
    expect(source).toContain("@/lib/auth/edge-logger")
  })

  it("detects a forbidden import when one is present (guard self-test)", () => {
    // Proves the walker actually inspects file contents rather than passing by
    // accident: lib/logger.ts is the canonical winston importer.
    const { violations } = walkGraph("lib/logger.ts")
    expect(violations.some((v) => v.specifier === "winston")).toBe(true)
  })
})
