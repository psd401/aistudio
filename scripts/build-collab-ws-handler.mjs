import { build } from "esbuild"
import { mkdir } from "node:fs/promises"
import { builtinModules } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Atrium collaboration WS handler bundle (#1051). Mirrors
// scripts/build-voice-ws-handler.mjs: Next.js standalone output does not include
// lib/content/collab/collab-server.ts (it is outside the page/route dependency
// graph), so it is bundled separately to .next/standalone/collab-handler-bundle.cjs
// and loaded by voice-server.js at runtime.

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, "..")
const entryPoint = path.join(repoRoot, "lib/content/collab/collab-server.ts")
const outfile = path.join(repoRoot, ".next/standalone/collab-handler-bundle.cjs")

const allowedExternalImports = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
  // Optional native accelerators used by ws / ioredis. They fall back cleanly.
  "bufferutil",
  "utf-8-validate",
])

await mkdir(path.dirname(outfile), { recursive: true })

const result = await build({
  entryPoints: [entryPoint],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  tsconfig: path.join(repoRoot, "tsconfig.json"),
  metafile: true,
  logLevel: "info",
})

const runtimeExternalImports = [...new Set(
  Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter((entry) => entry.external)
    .map((entry) => entry.path)
    .filter((entry) => !allowedExternalImports.has(entry)),
)].sort()

if (runtimeExternalImports.length > 0) {
  console.error(
    `[collab-bundle] Unexpected runtime externals in collab-handler bundle: ${runtimeExternalImports.join(", ")}`
  )
  process.exit(1)
}

console.log(
  `[collab-bundle] Wrote ${path.relative(repoRoot, outfile)} with only built-in runtime externals`
)
