/** @jest-environment node */

import fs from "node:fs"
import path from "node:path"

describe("Nexus attachment privacy gate ordering", () => {
  it("scans before every specialist or durable/external sink", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "app/api/nexus/chat/route.ts"),
      "utf8",
    )
    const turnStart = source.indexOf("const inlineSafetyResult =")
    const turnEnd = source.indexOf("// 9. Execute streaming", turnStart)
    const turn = source.slice(turnStart, turnEnd)

    const scan = turn.indexOf("await scanCanonicalInlineAttachments(")
    expect(scan).toBeGreaterThanOrEqual(0)
    for (const sink of [
      "await routeSpecialModel(",
      "await setupConversation(",
      "await bindAttachmentReferencesOrError(",
      "await persistLastUserMessage(",
      "await processMessagesWithAttachments(",
      "await resolveConnectorTools(",
    ]) {
      expect(scan).toBeLessThan(turn.indexOf(sink))
    }
  })

  it("uses the fail-closed required scan helper", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib/nexus/inline-attachment-security.ts"),
      "utf8",
    )
    expect(source).toContain("await runRequiredSecurityScan(")
    expect(source).toContain(
      "Attachment privacy scan failed; the attachment was not processed",
    )
  })
})
