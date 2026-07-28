import {
  evaluateMemoryGates,
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
})
