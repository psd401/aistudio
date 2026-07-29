import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("Nexus automatic memory onFinish wiring", () => {
  it("schedules only after assistant persistence and never awaits extraction", () => {
    const source = readFileSync(
      join(process.cwd(), "app/api/nexus/chat/route.ts"),
      "utf8",
    )
    const callbackStart = source.indexOf("function createOnFinishCallback")
    const callbackEnd = source.indexOf(
      "/**\n * Pre-merge the adapter",
      callbackStart,
    )
    const callback = source.slice(callbackStart, callbackEnd)

    const persisted = callback.indexOf("assistantMessagePersisted = true")
    const guarded = callback.indexOf("if (assistantMessagePersisted)")
    const scheduled = callback.indexOf(
      "scheduleNexusMemoryAutoExtraction({",
    )
    const cleanup = callback.indexOf("await closeMcpClients")

    expect(callbackStart).toBeGreaterThanOrEqual(0)
    expect(callbackEnd).toBeGreaterThan(callbackStart)
    expect(persisted).toBeGreaterThanOrEqual(0)
    expect(guarded).toBeGreaterThan(persisted)
    expect(scheduled).toBeGreaterThan(guarded)
    expect(cleanup).toBeGreaterThan(scheduled)
    expect(callback).not.toContain(
      "await scheduleNexusMemoryAutoExtraction",
    )
  })
})
