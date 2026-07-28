import { retirementCandidates } from "@/infra/lambdas/agent-skill-initializer/retirement"

describe("bundled skill retirement", () => {
  it("deduplicates safe explicit retirements and never retires an active name", () => {
    expect(
      retirementCandidates(
        ["psd-workflows"],
        [
          "psd-classified-evaluation",
          "psd-classified-evaluation",
          "psd-workflows",
          "../unsafe",
        ]
      )
    ).toEqual(["psd-classified-evaluation"])
  })
})
