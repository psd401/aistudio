/** @jest-environment node */

import fs from "node:fs"
import path from "node:path"

describe("Nexus attachment privacy gate ordering", () => {
  it("scans before any message persistence or attachment upload", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "app/api/nexus/chat/route.ts"),
      "utf8",
    )
    const turnStart = source.indexOf(
      "const messagesWithParts = convertMessagesToPartsFormat(",
    )
    const turnEnd = source.indexOf(
      "// 8. Resolve MCP connector tools",
      turnStart,
    )
    const turn = source.slice(turnStart, turnEnd)

    expect(turn.indexOf("await scanAttachmentPII(")).toBeGreaterThanOrEqual(0)
    expect(turn.indexOf("await scanAttachmentPII(")).toBeLessThan(
      turn.indexOf("await bindAttachmentReferencesOrError("),
    )
    expect(turn.indexOf("await scanAttachmentPII(")).toBeLessThan(
      turn.indexOf("await persistLastUserMessage("),
    )
    expect(turn.indexOf("await scanAttachmentPII(")).toBeLessThan(
      turn.indexOf("await processMessagesWithAttachments("),
    )
  })

  it("uses the fail-closed required scan helper", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "app/api/nexus/chat/route.ts"),
      "utf8",
    )
    expect(source).toContain("await runRequiredSecurityScan(")
    expect(source).toContain(
      "Attachment privacy scan failed; the attachment was not processed",
    )
  })
})
