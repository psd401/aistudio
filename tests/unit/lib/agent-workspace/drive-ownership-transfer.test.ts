import { validateWorkspaceCommand } from "@/lib/agent-workspace/command-executor"

const CALLER = "hagelk@psd401.net"
const agent = (argv: string[]) => ({ argv, scope: "agent" as const })

/**
 * Issue #1636: agent-created Drive files are owned by the agent account, and
 * Drive only lets an OWNER trash a file — so staff could not delete documents
 * the agent made for them, and every cleanup became an IT ticket.
 *
 * Both gates already permitted a transfer to the caller. What blocked it was
 * psd-workspace/SKILL.md, which listed "`owner` transfer" under "Never
 * allowed" two lines before showing the caller transfer as supported. These
 * tests pin the behaviour so the docs and the gates cannot drift apart again.
 */
describe("Drive ownership transfer to the requesting user", () => {
  it("permits owner + transferOwnership when the recipient is the caller", () => {
    expect(() =>
      validateWorkspaceCommand(
        agent([
          "drive", "permissions", "create",
          "--params", JSON.stringify({ fileId: "F", transferOwnership: true }),
          "--json", JSON.stringify({
            type: "user", role: "owner", emailAddress: CALLER,
          }),
        ]),
        CALLER
      )
    ).not.toThrow()
  })

  it("permits the same shape with everything in the body", () => {
    expect(() =>
      validateWorkspaceCommand(
        agent([
          "drive", "permissions", "create",
          "--json", JSON.stringify({
            fileId: "F", type: "user", role: "owner",
            emailAddress: CALLER, transferOwnership: true,
          }),
        ]),
        CALLER
      )
    ).not.toThrow()
  })

  it("still refuses an ownership transfer to a third party", () => {
    // The caller exemption exists so the agent can hand work to its OWN owner.
    // It must not become a route for giving district files away.
    expect(() =>
      validateWorkspaceCommand(
        agent([
          "drive", "permissions", "create",
          "--json", JSON.stringify({
            fileId: "F", type: "user", role: "owner",
            emailAddress: "someone.else@psd401.net", transferOwnership: true,
          }),
        ]),
        CALLER
      )
    ).toThrow()
  })

  it("still refuses ownership transfer to anyone/domain", () => {
    for (const resource of [
      { fileId: "F", type: "anyone", role: "owner", transferOwnership: true },
      { fileId: "F", type: "domain", role: "owner", domain: "psd401.net", transferOwnership: true },
    ]) {
      expect(() =>
        validateWorkspaceCommand(
          agent(["drive", "permissions", "create", "--json", JSON.stringify(resource)]),
          CALLER
        )
      ).toThrow()
    }
  })
})
