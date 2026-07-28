/** @jest-environment node */

const requireAdminMock = jest.fn()
const bulkImportAIModelsMock = jest.fn()
const getAIModelByModelIdMock = jest.fn()
const setModelRoleGrantsFromNamesMock = jest.fn()

jest.mock("@/lib/auth/admin-check", () => ({
  requireAdmin: (...args: unknown[]) => requireAdminMock(...args),
}))

jest.mock("@/lib/db/drizzle", () => ({
  bulkImportAIModels: (...args: unknown[]) => bulkImportAIModelsMock(...args),
  getAIModelByModelId: (...args: unknown[]) =>
    getAIModelByModelIdMock(...args),
}))

jest.mock("@/lib/db/drizzle/resource-access", () => ({
  setModelRoleGrantsFromNames: (...args: unknown[]) =>
    setModelRoleGrantsFromNamesMock(...args),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  }),
  generateRequestId: () => "request-1",
  startTimer: () => jest.fn(),
}))

import { POST } from "@/app/api/admin/models/import/route"

const VALID_MODEL = {
  modelId: "gpt-test",
  name: "GPT Test",
  provider: "openai",
}

function importRequest(models: unknown[]): Request {
  return new Request("http://localhost/api/admin/models/import", {
    body: JSON.stringify({ models }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

describe("admin model import route", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    requireAdminMock.mockResolvedValue(null)
    bulkImportAIModelsMock.mockResolvedValue({ created: 1, updated: 0 })
    getAIModelByModelIdMock.mockResolvedValue({ id: 42 })
  })

  it("rejects validation failures before writing models", async () => {
    const response = await POST(importRequest([{ ...VALID_MODEL, name: "" }]))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      isSuccess: false,
      message: "Validation failed",
    })
    expect(bulkImportAIModelsMock).not.toHaveBeenCalled()
  })

  it("rejects duplicate model IDs before writing models", async () => {
    const response = await POST(
      importRequest([VALID_MODEL, { ...VALID_MODEL, name: "Duplicate" }])
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      errors: ["Duplicate modelId: gpt-test"],
      message: "Duplicate modelIds in import",
    })
    expect(bulkImportAIModelsMock).not.toHaveBeenCalled()
  })

  it("imports models and translates legacy role restrictions", async () => {
    const response = await POST(
      importRequest([
        {
          ...VALID_MODEL,
          allowedRoles: ["administrator"],
          inputCostPer1kTokens: "0.001",
        },
      ])
    )

    expect(response.status).toBe(200)
    expect(bulkImportAIModelsMock).toHaveBeenCalledWith([
      expect.objectContaining({
        inputCostPer1kTokens: "0.001",
        modelId: "gpt-test",
      }),
    ])
    expect(getAIModelByModelIdMock).toHaveBeenCalledWith("gpt-test")
    expect(setModelRoleGrantsFromNamesMock).toHaveBeenCalledWith(
      42,
      ["administrator"],
      null
    )
    expect(await response.json()).toMatchObject({
      data: { created: 1, updated: 0 },
      isSuccess: true,
    })
  })

  it("does not alter grants when the legacy field is absent", async () => {
    const response = await POST(importRequest([VALID_MODEL]))

    expect(response.status).toBe(200)
    expect(getAIModelByModelIdMock).not.toHaveBeenCalled()
    expect(setModelRoleGrantsFromNamesMock).not.toHaveBeenCalled()
  })
})
