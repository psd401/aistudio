/**
 * @jest-environment node
 */
/* eslint-disable security/detect-non-literal-fs-filename -- fixed repo paths built from constants. */
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Keyless Google Chat auth (#1989) is one helper copied into every Chat-posting
// Lambda, because each Lambda builds from an isolated asset root and cannot
// import across directories. A copy that drifts from the canonical file would
// authenticate differently in one bundle, so every copy must be byte-identical.
const LAMBDAS = join(__dirname, "..", "..", "infra", "lambdas")
const CANONICAL = join(LAMBDAS, "shared", "google-chat-wif.ts")
const MIRRORS = [
  "agent-router",
  "agent-cron",
  "agent-triage-poll",
  "agent-triage-digest",
]

describe("google-chat-wif mirrors", () => {
  const canonical = readFileSync(CANONICAL, "utf8")

  it.each(MIRRORS)("%s/google-chat-wif.ts matches the shared copy", (dir) => {
    expect(readFileSync(join(LAMBDAS, dir, "google-chat-wif.ts"), "utf8")).toBe(
      canonical
    )
  })

  it.each(MIRRORS)("%s/package.json pins the same Chat client major", (dir) => {
    const pkg = JSON.parse(
      readFileSync(join(LAMBDAS, dir, "package.json"), "utf8")
    ) as { dependencies: Record<string, string> }
    expect(pkg.dependencies["@googleapis/chat"]).toBe("^47.0.0")
    expect(pkg.dependencies["@aws-sdk/credential-provider-node"]).toBeDefined()
  })
})
