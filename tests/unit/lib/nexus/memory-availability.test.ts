/* eslint-disable no-var */
var mockGetSetting = jest.fn()
/* eslint-enable no-var */

jest.mock("@/lib/settings-manager", () => ({
  getSetting: (...args: unknown[]) => mockGetSetting(...args),
}))

import {
  evaluateMemoryGates,
  isNexusMemoryGloballyEnabled,
  type MemoryGateInputs,
} from "@/lib/nexus/memory/memory-availability"

const ENABLED: MemoryGateInputs = {
  globalEnabled: true,
  capabilityGranted: true,
  userEnabled: true,
  conversationOwned: true,
  conversationEnabled: true,
}

describe("Nexus memory gate matrix", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("enables memory only when every gate passes", () => {
    expect(evaluateMemoryGates(ENABLED)).toEqual({
      enabled: true,
      reason: "enabled",
    })
  })

  it.each([
    ["globalEnabled", "global-disabled"],
    ["capabilityGranted", "capability-denied"],
    ["userEnabled", "user-disabled"],
    ["conversationOwned", "conversation-not-found"],
    ["conversationEnabled", "conversation-disabled"],
  ] as const)(
    "disables memory when %s is false",
    (gate, expectedReason) => {
      expect(
        evaluateMemoryGates({
          ...ENABLED,
          [gate]: false,
        }),
      ).toEqual({ enabled: false, reason: expectedReason })
    },
  )

  it.each([
    [null, true],
    ["true", true],
    ["false", false],
    ["0", false],
    ["off", false],
  ])("resolves global setting %p as %p", async (setting, expected) => {
    mockGetSetting.mockResolvedValue(setting)

    await expect(isNexusMemoryGloballyEnabled()).resolves.toBe(expected)
    expect(mockGetSetting).toHaveBeenCalledWith("NEXUS_MEMORY_ENABLED")
  })
})
