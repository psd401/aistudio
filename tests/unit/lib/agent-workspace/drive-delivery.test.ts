/** @jest-environment node */

/**
 * The Drive legs of private file delivery (#1885).
 *
 * The behaviour that matters here is narrow and security-relevant: the only
 * permission ever created is one writer grant to the agent's own user, nothing
 * is ever made link-visible, ownership is never transferred, and the
 * extension/MIME pairing is enforced per type (a `.xlsx` labelled as a PDF is a
 * file the user's Excel will refuse to open).
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals"

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  sanitizeForLogging: (value: unknown) => value,
}))

import {
  DRIVE_DELIVERY_CONTENT_TYPES,
  DRIVE_DELIVERY_ROLE,
  DriveDeliveryError,
  MAX_DRIVE_DELIVERY_BYTES,
  assertDriveDeliveryContentType,
  createAgentDriveFile,
  deleteAgentDriveFile,
  driveFileWebViewLink,
  isDriveDeliverableName,
  shareDriveFileWithUser,
} from "@/lib/agent-workspace/drive-delivery"

const TOKEN = "agent-access-token"
const AGENT = "agnt_jsmith@psd401.net"
const USER = "jsmith@psd401.net"
const BYTES = new Uint8Array([1, 2, 3, 4])

// `Response.json` is not available in this Jest environment's polyfilled
// Response, so build the JSON response by hand.
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

type RecordedCall = {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

/**
 * A Drive stand-in that keeps the permission state it is asked to create, so a
 * test can assert on the RESULTING permission list rather than on the fact that
 * one call was made.
 */
/** Drive's resumable-upload initiate leg. */
function initiateResponse(options: {
  failCreateWith?: number
  noLocation?: boolean
}): Response {
  if (options.failCreateWith) {
    return new Response("create denied", { status: options.failCreateWith })
  }
  return new Response("{}", {
    status: 200,
    headers: options.noLocation
      ? {}
      : { location: "https://upload.example/session/abc" },
  })
}

function fakeDrive(
  options: {
    failShareWith?: number
    failCreateWith?: number
    failDeleteWith?: number
    noLocation?: boolean
  } = {},
) {
  const calls: RecordedCall[] = []
  const permissions = new Map<
    string,
    Array<{ type: string; role: string; emailAddress: string }>
  >()
  const files = new Set<string>()

  const uploadBytes = (): Response => {
    const fileId = "drive-file-1"
    files.add(fileId)
    // The agent account is the file's OWNER the moment it is created.
    permissions.set(fileId, [
      { type: "user", role: "owner", emailAddress: AGENT },
    ])
    return jsonResponse({
      id: fileId,
      webViewLink: `https://drive.google.com/file/d/${fileId}/view`,
    })
  }

  const createPermission = (url: string, body: string): Response => {
    if (options.failShareWith) {
      return new Response("sharing quota exceeded", {
        status: options.failShareWith,
      })
    }
    const fileId = /files\/([^/]+)\/permissions/.exec(url)?.[1] ?? ""
    const permission = JSON.parse(body) as {
      type: string
      role: string
      emailAddress: string
    }
    permissions.get(fileId)?.push(permission)
    return jsonResponse({ id: "perm-1", ...permission })
  }

  const deleteFile = (url: string): Response => {
    if (options.failDeleteWith) {
      return new Response("", { status: options.failDeleteWith })
    }
    const fileId = /files\/([^/]+)$/.exec(url)?.[1] ?? ""
    files.delete(fileId)
    permissions.delete(fileId)
    return new Response("", { status: 204 })
  }

  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input)
    const method = init?.method ?? "GET"
    const rawBody = init?.body
    calls.push({
      url,
      method,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      ),
      body: typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody,
    })
    if (url.includes("/upload/drive/v3/files") && method === "POST") {
      return initiateResponse(options)
    }
    if (url.startsWith("https://upload.example/session/")) return uploadBytes()
    if (url.includes("/permissions") && method === "POST") {
      return createPermission(url, String(rawBody))
    }
    if (method === "DELETE") return deleteFile(url)
    throw new Error(`unexpected Drive call: ${method} ${url}`)
  }) as unknown as typeof fetch
  return { calls, permissions, files, deps: { fetchImpl } }
}

/**
 * The DriveDeliveryError a call threw, so a test can assert on its `code`
 * rather than on message prose.
 */
function thrownBy(call: () => unknown): DriveDeliveryError {
  try {
    call()
  } catch (error) {
    if (error instanceof DriveDeliveryError) return error
    throw error
  }
  throw new Error("expected a DriveDeliveryError; nothing was thrown")
}

/** Async counterpart of `thrownBy`. */
async function rejectedBy(call: Promise<unknown>): Promise<DriveDeliveryError> {
  try {
    await call
  } catch (error) {
    if (error instanceof DriveDeliveryError) return error
    throw error
  }
  throw new Error("expected a DriveDeliveryError; the call resolved")
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("Drive delivery type policy", () => {
  it.each([
    ["report.pdf", "application/pdf"],
    [
      "letter.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    [
      "budget.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    [
      "deck.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    ["roster.csv", "text/csv"],
    ["notes.txt", "text/plain"],
    ["notes.md", "text/markdown"],
    ["chart.png", "image/png"],
    ["photo.jpeg", "image/jpeg"],
    ["photo.jpg", "image/jpeg"],
    ["hero.webp", "image/webp"],
  ])("accepts %s as %s", (fileName, contentType) => {
    expect(assertDriveDeliveryContentType(fileName)).toBe(contentType)
    expect(assertDriveDeliveryContentType(fileName, contentType)).toBe(
      contentType,
    )
    expect(isDriveDeliverableName(fileName)).toBe(true)
  })

  it("accepts a charset parameter on a declared text type", () => {
    expect(
      assertDriveDeliveryContentType("notes.md", "text/markdown; charset=utf-8"),
    ).toBe("text/markdown")
  })

  it("refuses a declared type that disagrees with the extension", () => {
    expect(
      thrownBy(() =>
        assertDriveDeliveryContentType("budget.xlsx", "application/pdf"),
      ).code,
    ).toBe("content_type_mismatch")
    expect(
      thrownBy(() => assertDriveDeliveryContentType("report.pdf", "image/png"))
        .code,
    ).toBe("content_type_mismatch")
  })

  // `.svg` is active content and `.html` is a district document (it goes to
  // Atrium). Neither is deliverable, and nor is a type we simply do not handle.
  it.each(["archive.zip", "page.html", "icon.svg", "clip.mp4", "noextension"])(
    "refuses %s with unsupported_type",
    (fileName) => {
      expect(isDriveDeliverableName(fileName)).toBe(false)
      expect(thrownBy(() => assertDriveDeliveryContentType(fileName)).code).toBe(
        "unsupported_type",
      )
    },
  )

  it("lists every deliverable extension in the unsupported_type message", () => {
    let message = ""
    try {
      assertDriveDeliveryContentType("archive.zip")
    } catch (error) {
      message = (error as Error).message
    }
    for (const extension of DRIVE_DELIVERY_CONTENT_TYPES.keys()) {
      expect(message).toContain(extension)
    }
  })

  it("never offers a public-link fallback in any refusal", () => {
    for (const fileName of ["archive.zip", "page.html"]) {
      try {
        assertDriveDeliveryContentType(fileName)
      } catch (error) {
        expect((error as Error).message).not.toMatch(/attach|public link/i)
      }
    }
  })

  it("keeps the delivery cap aligned with the public artifact cap", () => {
    expect(MAX_DRIVE_DELIVERY_BYTES).toBe(100 * 1024 * 1024)
  })
})

describe("createAgentDriveFile", () => {
  it("initiates a resumable session and PUTs the bytes in one request", async () => {
    const drive = fakeDrive()
    const created = await createAgentDriveFile({
      accessToken: TOKEN,
      name: "deck.pptx",
      contentType: DRIVE_DELIVERY_CONTENT_TYPES.get(".pptx")!,
      bytes: BYTES,
      deps: drive.deps,
    })
    expect(created.fileId).toBe("drive-file-1")
    expect(created.webViewLink).toBe(
      "https://drive.google.com/file/d/drive-file-1/view",
    )
    const [initiate, upload] = drive.calls
    expect(initiate.url).toContain("uploadType=resumable")
    expect(initiate.url).toContain("fields=id%2CwebViewLink")
    expect(initiate.headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(initiate.headers["X-Upload-Content-Length"]).toBe("4")
    expect(initiate.body).toEqual({
      name: "deck.pptx",
      mimeType: DRIVE_DELIVERY_CONTENT_TYPES.get(".pptx"),
    })
    expect(upload.method).toBe("PUT")
    expect(upload.url).toBe("https://upload.example/session/abc")
    // Nothing in the create request asks for link visibility or a parent in a
    // shared drive: the file lands in the agent account's own My Drive.
    expect(JSON.stringify(drive.calls)).not.toMatch(
      /anyone|allowFileDiscovery|driveId/i,
    )
  })

  it("reports create_failed when Drive refuses the session", async () => {
    const drive = fakeDrive({ failCreateWith: 403 })
    const error = await rejectedBy(
      createAgentDriveFile({
        accessToken: TOKEN,
        name: "deck.pptx",
        contentType: DRIVE_DELIVERY_CONTENT_TYPES.get(".pptx")!,
        bytes: BYTES,
        deps: drive.deps,
      }),
    )
    expect(error.code).toBe("create_failed")
  })

  it("reports create_failed when no resumable session is returned", async () => {
    const drive = fakeDrive({ noLocation: true })
    await expect(
      createAgentDriveFile({
        accessToken: TOKEN,
        name: "deck.pptx",
        contentType: DRIVE_DELIVERY_CONTENT_TYPES.get(".pptx")!,
        bytes: BYTES,
        deps: drive.deps,
      }),
    ).rejects.toThrow("no resumable upload session")
  })
})

describe("shareDriveFileWithUser", () => {
  it("leaves the file with exactly two permissions: the agent and its user", async () => {
    const drive = fakeDrive()
    const created = await createAgentDriveFile({
      accessToken: TOKEN,
      name: "budget.xlsx",
      contentType: DRIVE_DELIVERY_CONTENT_TYPES.get(".xlsx")!,
      bytes: BYTES,
      deps: drive.deps,
    })
    await shareDriveFileWithUser({
      accessToken: TOKEN,
      fileId: created.fileId,
      userEmail: USER,
      deps: drive.deps,
    })
    expect(drive.permissions.get(created.fileId)).toEqual([
      { type: "user", role: "owner", emailAddress: AGENT },
      { type: "user", role: DRIVE_DELIVERY_ROLE, emailAddress: USER },
    ])
    const share = drive.calls.at(-1)!
    expect(share.url).toContain("sendNotificationEmail=false")
    // Exactly the three documented fields — no transferOwnership, no domain,
    // no `anyone`.
    expect(share.body).toEqual({
      type: "user",
      role: "writer",
      emailAddress: USER,
    })
  })

  it("creates one permission only, however many bytes were delivered", async () => {
    const drive = fakeDrive()
    const created = await createAgentDriveFile({
      accessToken: TOKEN,
      name: "report.pdf",
      contentType: "application/pdf",
      bytes: BYTES,
      deps: drive.deps,
    })
    await shareDriveFileWithUser({
      accessToken: TOKEN,
      fileId: created.fileId,
      userEmail: USER,
      deps: drive.deps,
    })
    const permissionCalls = drive.calls.filter((call) =>
      call.url.includes("/permissions"),
    )
    expect(permissionCalls).toHaveLength(1)
  })

  it("reports share_failed with a retry instruction and never a public fallback", async () => {
    const drive = fakeDrive({ failShareWith: 403 })
    const created = await createAgentDriveFile({
      accessToken: TOKEN,
      name: "report.pdf",
      contentType: "application/pdf",
      bytes: BYTES,
      deps: drive.deps,
    })
    const error = await rejectedBy(
      shareDriveFileWithUser({
        accessToken: TOKEN,
        fileId: created.fileId,
        userEmail: USER,
        deps: drive.deps,
      }),
    )
    expect(error.code).toBe("share_failed")
    expect(error.message).toContain("retry")
    expect(error.message).not.toMatch(/public/i)
  })

  it("reports share_failed when Drive cannot be reached at all", async () => {
    const deps = {
      fetchImpl: (async () => {
        throw new Error("socket hang up")
      }) as unknown as typeof fetch,
    }
    const error = await rejectedBy(
      shareDriveFileWithUser({
        accessToken: TOKEN,
        fileId: "drive-file-1",
        userEmail: USER,
        deps,
      }),
    )
    expect(error.code).toBe("share_failed")
  })
})

describe("deleteAgentDriveFile", () => {
  it("removes an unshared file and reports success", async () => {
    const drive = fakeDrive()
    const created = await createAgentDriveFile({
      accessToken: TOKEN,
      name: "report.pdf",
      contentType: "application/pdf",
      bytes: BYTES,
      deps: drive.deps,
    })
    await expect(
      deleteAgentDriveFile({
        accessToken: TOKEN,
        fileId: created.fileId,
        deps: drive.deps,
      }),
    ).resolves.toBe(true)
    expect(drive.files.size).toBe(0)
  })

  // Best effort by design: the caller is already reporting share_failed, and an
  // orphan nobody can open must not replace that with a cleanup error.
  it("reports false rather than throwing when the removal is refused", async () => {
    const drive = fakeDrive({ failDeleteWith: 500 })
    await expect(
      deleteAgentDriveFile({
        accessToken: TOKEN,
        fileId: "drive-file-1",
        deps: drive.deps,
      }),
    ).resolves.toBe(false)
  })
})

describe("driveFileWebViewLink", () => {
  it("builds the canonical view link and escapes the id", () => {
    expect(driveFileWebViewLink("abc123")).toBe(
      "https://drive.google.com/file/d/abc123/view",
    )
    expect(driveFileWebViewLink("a/b")).toBe(
      "https://drive.google.com/file/d/a%2Fb/view",
    )
  })
})
