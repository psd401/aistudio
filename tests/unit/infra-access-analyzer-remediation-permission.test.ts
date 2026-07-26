import fs from "node:fs"
import path from "node:path"

describe("Access Analyzer remediation role", () => {
  it("can update only tagged BaseIAMRole trust policies in dev", () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        "infra/lib/stacks/access-analyzer-stack.ts"
      ),
      "utf8"
    )
    const start = source.indexOf(
      'actions: ["iam:UpdateAssumeRolePolicy"]'
    )
    const statement = source.slice(start, source.indexOf("})", start) + 2)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(statement).toContain(
      "iam::${cdk.Aws.ACCOUNT_ID}:role/*"
    )
    expect(statement).not.toContain('resources: ["*"]')
    expect(statement).toContain('"aws:ResourceTag/Environment": "dev"')
    expect(statement).toContain(
      '"aws:ResourceTag/ManagedBy": "BaseIAMRole"'
    )
  })
})
