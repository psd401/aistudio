import { test, expect } from "./fixtures"
import { createAgentRequestProof } from "@/infra/lambdas/agent-router/invocation-context"

const ROUTE = "/api/agent/workflow-gateway"

function signedHeaders(body: string): Record<string, string> {
  const context = process.env.WORKFLOW_GATEWAY_E2E_CONTEXT
  const proofKey = process.env.WORKFLOW_GATEWAY_E2E_PROOF_KEY
  if (!context || !proofKey) {
    throw new Error("Live workflow gateway E2E credentials are unavailable")
  }
  return {
    "content-type": "application/json",
    "x-agent-invocation-context": context,
    ...createAgentRequestProof(proofKey, {
      method: "POST",
      route: ROUTE,
      body,
    }),
  }
}

test.describe("Workflow gateway broker", () => {
  test("new and legacy routes reject requests without signed proof", async ({
    request,
  }) => {
    for (const route of [
      ROUTE,
      "/api/agent/classified-evaluation",
    ]) {
      const response = await request.post(route, {
        data: { action: "list-tools" },
      })
      expect(response.status()).toBe(403)
    }
  })

  test("signed broker discovers and calls a live gateway schema tool", async ({
    request,
  }) => {
    test.skip(
      !process.env.WORKFLOW_GATEWAY_E2E_CONTEXT ||
        !process.env.WORKFLOW_GATEWAY_E2E_PROOF_KEY,
      "Requires a fresh dev router invocation context and proof key"
    )

    const listBody = JSON.stringify({ action: "list-tools" })
    const listed = await request.post(ROUTE, {
      headers: signedHeaders(listBody),
      data: listBody,
    })
    expect(listed.status()).toBe(200)
    const roster = (await listed.json()) as {
      tools?: Array<{ name?: unknown }>
    }
    expect(Array.isArray(roster.tools)).toBe(true)

    const configuredTool = process.env.WORKFLOW_GATEWAY_E2E_SCHEMA_TOOL
    const toolName =
      configuredTool ??
      roster.tools?.find(
        (tool) =>
          typeof tool.name === "string" &&
          tool.name.startsWith("get_") &&
          tool.name.endsWith("_schema")
      )?.name
    expect(typeof toolName).toBe("string")

    const callBody = JSON.stringify({
      toolName,
      arguments: {},
    })
    const called = await request.post(ROUTE, {
      headers: signedHeaders(callBody),
      data: callBody,
    })
    expect(called.status()).toBe(200)
    expect(await called.json()).toEqual(
      expect.objectContaining({ isError: false })
    )
  })
})
