/**
 * @jest-environment node
 *
 * The edge auth logger was a no-op outside development, silently dropping every
 * Edge-runtime auth/token-refresh warning/error in production (REV-COR-513). warn
 * and error must now emit in production; info/debug stay development-only; token
 * metadata is still redacted.
 */
import { createEdgeLogger } from "@/lib/auth/edge-logger"

const setEnv = (v: string) => {
  ;(process.env as Record<string, string | undefined>).NODE_ENV = v
}

describe("edge logger production emission (REV-COR-513)", () => {
  const OLD_ENV = process.env.NODE_ENV
  let errorSpy: ReturnType<typeof jest.spyOn>
  let warnSpy: ReturnType<typeof jest.spyOn>
  let logSpy: ReturnType<typeof jest.spyOn>

  beforeEach(() => {
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {})
    setEnv("production")
  })

  afterEach(() => {
    errorSpy.mockRestore()
    warnSpy.mockRestore()
    logSpy.mockRestore()
    setEnv(OLD_ENV ?? "test")
  })

  it("emits error and warn in production", () => {
    const log = createEdgeLogger({ context: "t" })
    log.error("boom")
    log.warn("careful")
    expect(errorSpy).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
  })

  it("redacts token metadata on the production error path", () => {
    const log = createEdgeLogger({ context: "t" })
    const raw = "x".repeat(40)
    log.error("boom", { token: raw })
    const emitted = String(errorSpy.mock.calls[0]?.[0] ?? "")
    expect(emitted).not.toContain(raw)
    expect(emitted).toContain("[REDACTED_TOKEN]")
  })

  it("does not emit info/debug in production", () => {
    const log = createEdgeLogger({ context: "t" })
    log.info("hello")
    log.debug("dbg")
    expect(logSpy).not.toHaveBeenCalled()
  })
})
