import { build } from "esbuild"
import { mkdir } from "node:fs/promises"
import { builtinModules } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, "..")
const entryPoint = path.join(repoRoot, "lib/voice/ws-handler.ts")
const outfile = path.join(repoRoot, ".next/standalone/ws-handler-bundle.cjs")

const allowedExternalImports = new Set([
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`),
  // Optional native accelerators used by ws. The package falls back cleanly when absent.
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
    `[voice-bundle] Unexpected runtime externals in ws-handler bundle: ${runtimeExternalImports.join(", ")}`
  )
  process.exit(1)
}

console.log(
  `[voice-bundle] Wrote ${path.relative(repoRoot, outfile)} with only built-in runtime externals`
)
