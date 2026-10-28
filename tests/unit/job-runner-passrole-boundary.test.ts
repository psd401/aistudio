/** @jest-environment node */
/**
 * The router and cron Lambdas launch the job-runner Fargate task (turn
 * promotion past the 550s interactive deadline, long scheduled runs), and
 * RunTask needs iam:PassRole on the task's roles. Their permissions boundary
 * must allow that PassRole too: #1990 renamed the task role to
 * psd-agent-job-runner-task-role-{env} and the boundary's `*JobRunner*`
 * pattern (case-sensitive) stopped matching, so every promotion failed with
 * "no permissions boundary allows the iam:PassRole action" (dev, 2026-10-28).
 *
 * This lives directly under tests/unit because root jest ignores any path
 * containing /infra/, tests/unit/infra/ included.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

const ROOT = join(__dirname, "..", "..")
const FILES = {
  devBoundary: join(ROOT, "infra/lib/constructs/security/permission-boundaries/dev-boundary.json"),
  prodBoundary: join(ROOT, "infra/lib/constructs/security/permission-boundaries/prod-boundary.json"),
  agentPlatformStack: join(ROOT, "infra/lib/agent-platform-stack.ts"),
  serviceRoleFactory: join(ROOT, "infra/lib/constructs/security/service-role-factory.ts"),
} as const
// Paths are the fixed repository files above, never input.
// eslint-disable-next-line security/detect-non-literal-fs-filename
const read = (file: keyof typeof FILES) => readFileSync(FILES[file], "utf8")

interface Statement {
  Sid?: string
  Effect: string
  Action: string | string[]
  Resource: string | string[]
  Condition?: { StringEquals?: Record<string, string> }
}

function passRoleStatement(env: "dev" | "prod"): Statement {
  const doc = JSON.parse(read(env === "dev" ? "devBoundary" : "prodBoundary")) as {
    Statement: Statement[]
  }
  const statement = doc.Statement.find((s) => s.Sid === "AllowPassRoleToEcsTasks")
  if (!statement) throw new Error(`${env} boundary has no AllowPassRoleToEcsTasks`)
  return statement
}

/** IAM ARN wildcard match: `*` is any run of characters, case-sensitive. */
function iamGlobMatches(pattern: string, value: string): boolean {
  const parts = pattern.split("*")
  const first = parts[0]
  const last = parts[parts.length - 1]
  if (!value.startsWith(first)) return false
  if (parts.length === 1) return value === pattern
  let at = first.length
  for (const middle of parts.slice(1, -1)) {
    const found = value.indexOf(middle, at)
    if (found < 0) return false
    at = found + middle.length
  }
  return value.length - last.length >= at && value.endsWith(last)
}

function allowsPassRole(env: "dev" | "prod", roleName: string): boolean {
  const statement = passRoleStatement(env)
  const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource]
  const arn = `arn:aws:iam::390844780692:role/${roleName}`
  return resources.some((pattern) => iamGlobMatches(pattern, arn))
}

describe("job-runner PassRole is allowed by the permissions boundary", () => {
  it("the stack still names the task role psd-agent-job-runner-task-role-{env}", () => {
    // If either of these changes, the role name below changes with it.
    expect(read("agentPlatformStack")).toMatch(
      /createECSTaskRole\(this, 'JobRunnerTaskRole', \{\s*taskName: 'psd-agent-job-runner',/
    )
    expect(read("serviceRoleFactory")).toContain(
      "roleName: `${props.taskName}-task-role-${props.environment}`,"
    )
  })

  it.each(["dev", "prod"] as const)("%s boundary allows PassRole on both job-runner roles", (env) => {
    // Task role: fixed name since #1990.
    expect(allowsPassRole(env, `psd-agent-job-runner-task-role-${env}`)).toBe(true)
    // Execution role: still CDK-generated, e.g. as deployed in dev.
    expect(
      allowsPassRole(env, "AIStudio-AgentPlatformSta-JobRunnerTaskDefExecution-wHSBa3cSY2cP")
    ).toBe(true)
    // Scoped to ECS tasks only.
    expect(passRoleStatement(env).Condition?.StringEquals?.["iam:PassedToService"]).toBe(
      "ecs-tasks.amazonaws.com"
    )
  })

  it("the case-sensitive match that broke is real: `*JobRunner*` alone misses the new name", () => {
    expect(
      iamGlobMatches(
        "arn:aws:iam::*:role/*JobRunner*",
        "arn:aws:iam::390844780692:role/psd-agent-job-runner-task-role-dev"
      )
    ).toBe(false)
  })
})
