/** @jest-environment node */

import {
  Headers as UndiciHeaders,
  Request as UndiciRequest,
  Response as UndiciResponse,
} from "undici"
import { invokeNodeHttpHandler } from "@/lib/oauth/node-http-adapter"

Object.assign(globalThis, {
  Headers: UndiciHeaders,
  Request: UndiciRequest,
  Response: UndiciResponse,
})

describe("OIDC Node/Web response adapter", () => {
  it("uses statusCode set without writeHead and preserves the body", async () => {
    const response = await invokeNodeHttpHandler(
      new Request("https://aistudio.example/api/oauth/auth"),
      "/auth",
      (_request, nodeResponse) => {
        nodeResponse.statusCode = 303
        nodeResponse.end("Redirecting…")
      }
    )

    expect(response.status).toBe(303)
    expect(await response.text()).toBe("Redirecting…")
  })

  it("uses an explicit writeHead status", async () => {
    const response = await invokeNodeHttpHandler(
      new Request("https://aistudio.example/api/oauth/auth"),
      "/auth",
      (_request, nodeResponse) => {
        nodeResponse.writeHead(307)
        nodeResponse.end()
      }
    )

    expect(response.status).toBe(307)
  })

  it("forwards Location exactly", async () => {
    const location =
      "/oauth/authorize?uid=abc%2F123&return=https%3A%2F%2Fclient.example"
    const response = await invokeNodeHttpHandler(
      new Request("https://aistudio.example/api/oauth/auth"),
      "/auth",
      (_request, nodeResponse) => {
        nodeResponse.statusCode = 303
        nodeResponse.setHeader("Location", location)
        nodeResponse.end()
      }
    )

    expect(response.headers.get("location")).toBe(location)
  })

  it("preserves multiple Set-Cookie headers separately", async () => {
    const cookies = [
      "_interaction=one; Path=/api/oauth; HttpOnly; Secure",
      "_session=two; Path=/api/oauth; HttpOnly; Secure",
    ]
    const response = await invokeNodeHttpHandler(
      new Request("https://aistudio.example/api/oauth/auth"),
      "/auth",
      (_request, nodeResponse) => {
        nodeResponse.statusCode = 303
        nodeResponse.setHeader("Set-Cookie", cookies)
        nodeResponse.end()
      }
    )

    expect(response.headers.getSetCookie()).toEqual(cookies)
  })

  it("rejects when the Node callback promise rejects", async () => {
    await expect(
      invokeNodeHttpHandler(
        new Request("https://aistudio.example/api/oauth/auth"),
        "/auth",
        async () => {
          throw new Error("provider failed")
        }
      )
    ).rejects.toThrow("provider failed")
  })
})
