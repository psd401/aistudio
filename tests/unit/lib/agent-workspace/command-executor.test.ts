import {
  executeWorkspaceCommand,
  outboundMessageAudit,
  requiredWorkspaceScopeGap,
  validateEmailTaskWorkspaceCommand,
  validateScheduledWorkspaceCommand,
  validateWorkspaceCommand,
  workspaceOperation,
} from "@/lib/agent-workspace/command-executor"

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder"
const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file"
const DRIVE_METADATA_SCOPE = "https://www.googleapis.com/auth/drive.metadata"
const DRIVE_READ_SCOPE = "https://www.googleapis.com/auth/drive.readonly"

function defineTrustedWorkspaceCommandPolicySuite1Part1() {
  it("limits sender-influenced email tasks to one task-insert operation", () => {
    expect(() =>
      validateEmailTaskWorkspaceCommand({
        scope: "user",
        argv: [
          "tasks",
          "tasks",
          "insert",
          "--params",
          '{"tasklist":"@default"}',
          "--json",
          '{"title":"Review email"}',
        ],
      })
    ).not.toThrow()
    expect(() =>
      validateEmailTaskWorkspaceCommand({
        scope: "user",
        argv: ["gmail", "users", "messages", "list"],
      })
    ).toThrow("only insert")
    expect(() =>
      validateEmailTaskWorkspaceCommand({
        scope: "agent",
        argv: ["tasks", "tasks", "insert"],
      })
    ).toThrow("only insert")
  })

  it("allows bounded read operations", () => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "user",
        argv: ["gmail", "users", "messages", "list", "--params", '{"userId":"me"}'],
      })
    ).not.toThrow()
  })

  it.each([
    ["long flag", "--output", "/app/.next/cache/poisoned"],
    ["long equals", "--output=/app/.next/cache/poisoned"],
    ["short flag", "-o", "/app/.next/cache/poisoned"],
    ["short equals", "-o=/app/.next/cache/poisoned"],
    ["short attached", "-o/app/.next/cache/poisoned"],
    ["mixed case", "--OuTpUt=/app/.next/cache/poisoned"],
  ])("rejects caller-selected response files via %s", (_name, ...flags) => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "user",
        argv: [
          "drive",
          "files",
          "export",
          "--params",
          '{"fileId":"drive-controlled"}',
          ...flags,
        ],
      })
    ).toThrow(/cannot write response data to a file/)
  })

  it("rejects a mutation token hidden before a read action", () => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "user",
        argv: ["drive", "files", "delete", "list"],
      })
    ).toThrow(/contains a mutation/)
  })

  it.each([
    ["gmail", "users", "messages", "send"],
    ["gmail", "users", "messages", "delete"],
    ["calendar", "events", "delete"],
    ["drive", "files", "delete"],
  ])("rejects destructive or external-effect operation %s", (...argv) => {
    expect(() =>
      validateWorkspaceCommand({ scope: "user", argv })
    ).toThrow(/not allowed/)
  })

  // Regression: `gmail +draft` is the form SKILL.md documents for composing a
  // draft, but only the canonical `gmail users drafts create` was allowlisted,
  // so every documented invocation was refused (agent_failures 1953) and the
  // agent had no way to draft mail at all.
  it("allows the documented gmail +draft helper on the user slot", () => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "user",
        argv: ["gmail", "+draft", "--to", "bill@psd401.net", "--subject", "Hi"],
      })
    ).not.toThrow()
  })

  it.each([["+send"], ["+reply"], ["+reply-all"], ["+forward"]])(
    "still refuses the mail-sending helper %s",
    (verb) => {
      expect(() =>
        validateWorkspaceCommand({
          scope: "user",
          argv: ["gmail", verb, "--to", "bill@psd401.net"],
        })
      ).toThrow(/not allowed/)
    }
  )

  // A move carries no --json body — addParents/removeParents are query params.
  // The skill gate allows it; this validator must agree, or the command passes
  // the skill and then dies here with operation_not_allowed.
  it("allows a params-only Drive parent move on the user slot", () => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "user",
        argv: [
          "drive", "files", "update",
          "--params", '{"fileId":"f1","addParents":"folder2","removeParents":"folder1"}',
        ],
      })
    ).not.toThrow()
    expect(() =>
      validateWorkspaceCommand({
        scope: "user",
        argv: ["drive", "files", "update", "--params", '{"fileId":"f1","addParents":"f2"}'],
      })
    ).not.toThrow()
  })

  it("requires agent ownership for file creation", () => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "user",
        argv: ["docs", "documents", "create", "--json", "{}"],
      })
    ).toThrow(/agent-owned/)
  })

  it("allows a user-owned Drive folder with no content", () => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "user",
        argv: [
          "drive",
          "files",
          "create",
          "--json",
          JSON.stringify({
            name: "Budget 2026",
            mimeType: DRIVE_FOLDER_MIME,
          }),
        ],
      })
    ).not.toThrow()
  })

  }

function defineTrustedWorkspaceCommandPolicySuite1Part2() {
  it("still refuses a move that smuggles content or unknown query params", () => {
    const move = (params: string, extra: string[] = []) =>
      validateWorkspaceCommand({
        scope: "user",
        argv: ["drive", "files", "update", "--params", params, ...extra],
      })
    expect(() => move('{"fileId":"f1","addParents":"f2","uploadType":"media"}')).toThrow()
    expect(() => move('{"fileId":"f1","addParents":"f2","unexpected":"x"}')).toThrow()
    // No parents and no body — nothing to inspect, so still refused.
    expect(() => move('{"fileId":"f1"}')).toThrow()
    // Parents plus a non-metadata body is still judged on the body.
    expect(() => move('{"fileId":"f1","addParents":"f2"}', ["--json", '{"trashed":true}'])).toThrow()
    // Parents plus a metadata body is a rename+move.
    expect(() => move('{"fileId":"f1","addParents":"f2"}', ["--json", '{"name":"Q3"}'])).not.toThrow()
  })

  it.each([
    {
      name: "non-folder",
      argv: [
        "drive",
        "files",
        "create",
        "--json",
        JSON.stringify({
          name: "Report",
          mimeType: "application/vnd.google-apps.document",
        }),
      ],
    },
    {
      name: "content attachment",
      argv: [
        "drive",
        "files",
        "create",
        "--json",
        JSON.stringify({ name: "Folder", mimeType: DRIVE_FOLDER_MIME }),
        "--media",
        "/tmp/content",
      ],
    },
    {
      name: "trash field",
      argv: [
        "drive",
        "files",
        "create",
        "--json",
        JSON.stringify({
          name: "Folder",
          mimeType: DRIVE_FOLDER_MIME,
          trashed: false,
        }),
      ],
    },
  ])("rejects user-owned Drive folder creation with $name", ({ argv }) => {
    expect(() =>
      validateWorkspaceCommand({ scope: "user", argv })
    ).toThrow(/limited to an untrashed folder/)
  })

  it("allows approved user-owned Drive metadata updates", () => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "user",
        argv: [
          "drive",
          "files",
          "update",
          "--params",
          JSON.stringify({
            fileId: "file-1",
            addParents: "folder-1",
            removeParents: "folder-2",
          }),
          "--json",
          JSON.stringify({ name: "Renamed", starred: true }),
        ],
      })
    ).not.toThrow()
  })

  it.each([
    { name: "content field", resource: { contentHints: { indexableText: "x" } } },
    { name: "trash field", resource: { trashed: true } },
    { name: "unknown field", resource: { name: "x", owners: ["other"] } },
  ])("rejects user-owned Drive updates with $name", ({ resource }) => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "user",
        argv: [
          "drive",
          "files",
          "update",
          "--json",
          JSON.stringify(resource),
        ],
      })
    ).toThrow(/approved metadata/)
  })

  it("rejects user-owned Drive metadata updates that attach content", () => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "user",
        argv: [
          "drive",
          "files",
          "update",
          "--json",
          JSON.stringify({ name: "Renamed" }),
          "--upload-type",
          "media",
        ],
      })
    ).toThrow(/approved metadata/)
  })

  }

function defineTrustedWorkspaceCommandPolicySuite1Part3() {it("rejects Gmail modify attempts that add TRASH", () => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "user",
        argv: [
          "gmail",
          "users",
          "messages",
          "modify",
          "--json",
          '{"addLabelIds":["TRASH"]}',
        ],
      })
    ).toThrow(/destructive/)
  })

  it.each([
    ["calendar", "events", "patch"],
    ["calendar", "events", "update"],
    ["docs", "documents", "batchUpdate"],
    ["sheets", "spreadsheets", "batchUpdate"],
    ["slides", "presentations", "batchUpdate"],
    ["tasks", "tasks", "patch"],
    ["tasks", "tasks", "update"],
  ])("allows %s %s %s on the agent slot", (...argv) => {
    // These were refused by a provenance gate that nothing could satisfy, so an
    // agent could create a Doc and never write to or share it (agent_failures
    // 798). They are ordinary agent-slot writes now.
    expect(() =>
      validateWorkspaceCommand({ scope: "agent", argv })
    ).not.toThrow()
  })


  it.each([
    ["calendar", "events", "insert"],
    ["docs", "documents", "create"],
    ["sheets", "spreadsheets", "create"],
    ["slides", "presentations", "create"],
    ["tasks", "tasks", "insert"],
  ])("preserves safe agent create operation %s %s %s", (...argv) => {
    expect(() =>
      validateWorkspaceCommand({ scope: "agent", argv })
    ).not.toThrow()
  })

  it.each([
    [
      "helper",
      [
        "chat",
        "+send",
        "--space",
        "spaces/AAQA13FQZFA",
        "--text",
        "Test summary",
      ],
    ],
    [
      "raw API",
      [
        "chat",
        "spaces",
        "messages",
        "create",
        "--params",
        '{"parent":"spaces/AAQA13FQZFA"}',
        "--json",
        '{"text":"Test summary"}',
      ],
    ],
  ])("allows agent-owned Chat messages through the %s form", (_name, argv) => {
    expect(() =>
      validateWorkspaceCommand({ scope: "agent", argv })
    ).not.toThrow()
  })

  it.each([
    [
      "helper",
      [
        "chat",
        "+send",
        "--space",
        "spaces/AAQA13FQZFA",
        "--text",
        "No",
      ],
    ],
    [
      "raw API",
      [
        "chat",
        "spaces",
        "messages",
        "create",
        "--params",
        '{"parent":"spaces/AAQA13FQZFA"}',
        "--json",
        '{"text":"No"}',
      ],
    ],
  ])("keeps Chat message writes off the human user slot via %s", (_name, argv) => {
    expect(() =>
      validateWorkspaceCommand({ scope: "user", argv })
    ).toThrow(/agent-owned Workspace account/)
  })

  it("does not let the Chat send helper hide before a read action", () => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "agent",
        argv: ["chat", "+send", "list"],
      })
    ).toThrow(/contains a mutation/)
  })

  it.each([
    [
      "helper",
      [
        "chat",
        "+send",
        "--space",
        "spaces/AAQA13FQZFA",
        "--text",
        "No",
      ],
    ],
    ["raw API", ["chat", "spaces", "messages", "create", "--json", "{}"]],
  ])("allows %s Chat sends from scheduled runs", (_name, argv) => {
    // Recurring jobs post to spaces their owner named when creating the
    // schedule. This previously threw; the gate could not distinguish
    // pre-authorized destinations from arbitrary ones and refused both.
    expect(() =>
      validateScheduledWorkspaceCommand({ scope: "agent", argv })
    ).not.toThrow()
  })

  it("keeps scheduled Workspace reads available", () => {
    expect(() =>
      validateScheduledWorkspaceCommand({
        scope: "agent",
        argv: ["chat", "spaces", "messages", "list"],
      })
    ).not.toThrow()
  })

  it.each([
    ["append", ["sheets", "spreadsheets", "values", "append"]],
    ["update", ["sheets", "spreadsheets", "values", "update"]],
  ])("allows intentional scheduled Sheet value %s sync", (_name, argv) => {
    expect(() =>
      validateScheduledWorkspaceCommand({ scope: "agent", argv })
    ).not.toThrow()
  })
}

function defineTrustedWorkspaceCommandPolicySuite1Part4() {
  it.each([
    ["calendar", "events", "patch"],
    ["calendar", "events", "update"],
    ["docs", "documents", "batchUpdate"],
    ["drive", "permissions", "create"],
    ["sheets", "spreadsheets", "batchUpdate"],
    ["slides", "presentations", "batchUpdate"],
    ["tasks", "tasks", "patch"],
    ["tasks", "tasks", "update"],
  ])("still refuses %s %s %s on the user slot", (...argv) => {
    // The impersonation boundary is what survives removing the gate: the same
    // call on the user slot would restructure the user's own Workspace as them.
    expect(() =>
      validateWorkspaceCommand({ scope: "user", argv })
    ).toThrow(/must use the agent-owned Workspace account/)
  })
}

const defineTrustedWorkspaceCommandPolicySuite1 = () => {
  defineTrustedWorkspaceCommandPolicySuite1Part1()
  defineTrustedWorkspaceCommandPolicySuite1Part2()
  defineTrustedWorkspaceCommandPolicySuite1Part3()
  defineTrustedWorkspaceCommandPolicySuite1Part4()
};

describe("trusted Workspace command policy", defineTrustedWorkspaceCommandPolicySuite1)

describe("Sheet value command policy", () => {
  it.each([
    ["sheets", "spreadsheets", "values", "append"],
    ["sheets", "spreadsheets", "values", "update"],
  ])("allows agent-owned Sheet value writes via %s %s %s %s", (...argv) => {
    expect(() =>
      validateWorkspaceCommand({ scope: "agent", argv })
    ).not.toThrow()
  })

  it.each([
    ["sheets", "spreadsheets", "values", "append"],
    ["sheets", "spreadsheets", "values", "update"],
  ])("keeps Sheet value writes off the human user slot", (...argv) => {
    expect(() =>
      validateWorkspaceCommand({ scope: "user", argv })
    ).toThrow(/agent-owned Workspace account/)
  })

  it("allows canonical Sheet value reads and corrects the +read helper", () => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "agent",
        argv: ["sheets", "spreadsheets", "values", "get"],
      })
    ).not.toThrow()
    expect(() =>
      validateWorkspaceCommand({
        scope: "agent",
        argv: ["sheets", "+read", "get"],
      })
    ).toThrow(/`\+read`.*`sheets spreadsheets values get`/)
  })
})

describe("Workspace operation diagnostics", () => {
  it("preserves ordinary command operations", () => {
    expect(
      workspaceOperation(["SHEETS", "spreadsheets", "values", "update"])
    ).toBe("sheets spreadsheets values update")
  })

  it("replaces oversized operations with an explicit bounded sentinel", () => {
    expect(workspaceOperation(["X".repeat(1_000_000)])).toBe(
      "<operation-too-long>"
    )
  })

  it("uses an explicit sentinel when no operation tokens are available", () => {
    expect(workspaceOperation(["--help"])).toBe("<operation-unavailable>")
  })
})

const defineWorkspaceUserSlotScopeUpgradesSuite2 = () => {
  const oldScopes = DRIVE_FILE_SCOPE
  const currentScopes = [
    DRIVE_FILE_SCOPE,
    DRIVE_METADATA_SCOPE,
    DRIVE_READ_SCOPE,
  ].join(" ")

  it.each([
    ["drive files list", ["drive", "files", "list"], DRIVE_READ_SCOPE],
    ["drive files get", ["drive", "files", "get"], DRIVE_READ_SCOPE],
    ["drive files export", ["drive", "files", "export"], DRIVE_READ_SCOPE],
    ["drive changes list", ["drive", "changes", "list"], DRIVE_READ_SCOPE],
    ["drive files update", ["drive", "files", "update"], DRIVE_METADATA_SCOPE],
  ])("detects the missing scope for %s", (_name, argv, expectedScope) => {
    expect(requiredWorkspaceScopeGap(argv, oldScopes)).toMatchObject({
      scopes: [expectedScope],
    })
  })

  it("does not prompt after the user grants the current scopes", () => {
    expect(
      requiredWorkspaceScopeGap(["drive", "files", "list"], currentScopes)
    ).toBeNull()
    expect(
      requiredWorkspaceScopeGap(["drive", "files", "update"], currentScopes)
    ).toBeNull()
  })

  it("does not force a migration when Google omits the granted scope string", () => {
    expect(
      requiredWorkspaceScopeGap(["drive", "files", "list"], undefined)
    ).toBeNull()
  })
};

describe("Workspace user-slot scope upgrades", defineWorkspaceUserSlotScopeUpgradesSuite2)

const defineWorkspaceHelperVerbSmugglingSuite3 = () => {
  it.each([
    ["gmail +reply", ["gmail", "+reply", "list"]],
    ["gmail +reply-all", ["gmail", "+reply-all", "list"]],
    ["gmail +forward", ["gmail", "+forward", "get"]],
    ["gmail +send", ["gmail", "+send", "list"]],
    ["chat +send", ["chat", "+send", "get"]],
  ])(
    "refuses %s hidden behind a trailing read action on the user slot",
    (_name, argv) => {
      expect(() =>
        validateWorkspaceCommand({ scope: "user", argv })
      ).toThrow(/contains a mutation/)
      expect(() =>
        validateWorkspaceCommand({ scope: "agent", argv })
      ).toThrow(/contains a mutation/)
    }
  )

  it("still allows ordinary read commands", () => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "user",
        argv: ["gmail", "users", "messages", "list"],
      })
    ).not.toThrow()
    expect(() =>
      validateWorkspaceCommand({
        scope: "agent",
        argv: ["chat", "spaces", "list"],
      })
    ).not.toThrow()
  })
};

describe("Workspace helper-verb read smuggling", defineWorkspaceHelperVerbSmugglingSuite3)

const defineWorkspaceOutboundAuditSuite4 = () => {
  it("records the destination and body length of a helper-form Chat send", () => {
    expect(
      outboundMessageAudit([
        "chat",
        "+send",
        "--space",
        "spaces/AAQA13FQZFA",
        "--text",
        "Daily digest",
      ])
    ).toEqual({ space: "spaces/AAQA13FQZFA", textLength: 12 })
  })

  it("recovers the destination the logged operation prefix cannot see", () => {
    expect(
      outboundMessageAudit([
        "chat",
        "spaces",
        "messages",
        "create",
        "--params",
        JSON.stringify({ parent: "spaces/AAQA13FQZFA" }),
        "--json",
        JSON.stringify({ text: "Daily digest" }),
      ])
    ).toEqual({ space: "spaces/AAQA13FQZFA", textLength: 12 })
  })

  it("unwraps a resource-wrapped raw payload", () => {
    expect(
      outboundMessageAudit([
        "chat",
        "spaces",
        "messages",
        "create",
        "--params",
        JSON.stringify({ parent: "spaces/AAQA13FQZFA" }),
        "--json",
        JSON.stringify({ resource: { text: "Hi" } }),
      ])
    ).toEqual({ space: "spaces/AAQA13FQZFA", textLength: 2 })
  })

  it("returns null for operations that do not leave the owner's Workspace", () => {
    expect(
      outboundMessageAudit(["gmail", "users", "drafts", "create"])
    ).toBeNull()
    expect(outboundMessageAudit(["chat", "spaces", "list"])).toBeNull()
  })

  it("reports a missing destination rather than inventing one", () => {
    expect(
      outboundMessageAudit(["chat", "+send", "--text", "orphan"])
    ).toEqual({ space: null, textLength: 6 })
  })

  it.each([
    ["helper", ["chat", "+send", "--space", "spaces/X", "--text", "hi"]],
    [
      "raw API",
      ["chat", "spaces", "messages", "create", "--params", '{"parent":"s"}'],
    ],
  ])("audits every allowlisted Chat write via the %s form", (_name, argv) => {
    expect(() => validateWorkspaceCommand({ scope: "agent", argv })).not.toThrow()
    expect(outboundMessageAudit(argv)).not.toBeNull()
  })
};

describe("Workspace outbound message audit", defineWorkspaceOutboundAuditSuite4)

const defineEmailTaskChatRejectionSuite5 = () => {
  it.each([
    ["helper", ["chat", "+send", "--space", "spaces/X", "--text", "hi"]],
    [
      "raw API",
      ["chat", "spaces", "messages", "create", "--params", '{"parent":"s"}'],
    ],
  ])("keeps sender-influenced email tasks from sending Chat via %s", (
    _name,
    argv
  ) => {
    expect(() =>
      validateEmailTaskWorkspaceCommand({ scope: "agent", argv })
    ).toThrow(/only insert a user-owned Google task/)
    expect(() =>
      validateEmailTaskWorkspaceCommand({ scope: "user", argv })
    ).toThrow()
  })
};

describe("Email-task mode excludes Chat sends", defineEmailTaskChatRejectionSuite5)

// The static gates prove the agent SLOT and the permission SHAPE, but not whose
// file it is. Users can share their own files into the agnt_ account, so
// without a Drive check a user-owned file could be re-shared onward past the
// "your own files" boundary the exception is written around.
describe("Drive share ownership verification", () => {
  const share = {
    scope: "agent" as const,
    argv: [
      "drive", "permissions", "create",
      "--json",
      '{"fileId":"f1","type":"user","role":"writer","emailAddress":"hagelk@psd401.net"}',
    ],
  }
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("refuses a share of a file the agent does not own", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ ownedByMe: false }), { status: 200 })
    ) as unknown as typeof fetch
    await expect(executeWorkspaceCommand(share, "token")).rejects.toThrow(
      /files the agent owns/
    )
  })

  it("fails closed when ownership cannot be determined", async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      new Response("", { status: 404 })
    ) as unknown as typeof fetch
    await expect(executeWorkspaceCommand(share, "token")).rejects.toThrow(
      /ownership could not be verified/
    )
  })

  it("fails closed when the ownership check errors", async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch
    await expect(executeWorkspaceCommand(share, "token")).rejects.toThrow(
      /ownership could not be verified/
    )
  })

  it("refuses a share with no fileId to verify", async () => {
    globalThis.fetch = jest.fn() as unknown as typeof fetch
    await expect(
      executeWorkspaceCommand(
        {
          scope: "agent",
          argv: [
            "drive", "permissions", "create",
            "--json", '{"type":"domain","role":"reader","domain":"psd401.net"}',
          ],
        },
        "token"
      )
    ).rejects.toThrow(/requires a fileId/)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it("does not run an ownership check for non-share operations", async () => {
    globalThis.fetch = jest.fn() as unknown as typeof fetch
    // Reaches the CLI (which is absent here), proving the guard was skipped
    // rather than short-circuiting on ownership.
    await expect(
      executeWorkspaceCommand(
        { scope: "agent", argv: ["drive", "files", "list"] },
        "token"
      )
    ).rejects.not.toThrow(/ownership/)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

// Ownership alone is not enough: an agent-OWNED file could otherwise be shared
// to anyone, to an external address, or domain-wide as writer. The skill-side
// allowlist can be bypassed by calling the broker directly, so the shape has to
// be re-proved at this boundary or the documented policy is advisory only.
describe("Drive share shape at the broker boundary", () => {
  const share = (resource: Record<string, unknown>) =>
    validateWorkspaceCommand({
      scope: "agent",
      argv: ["drive", "permissions", "create", "--json", JSON.stringify(resource)],
    })

  // `drive permissions create` is an ordinary agent-slot write, but unlike the
  // other agent-slot operations it must additionally prove an in-district share
  // shape, so it is asserted with a payload rather than bare.
  it("allows the two documented in-district shapes", () => {
    expect(() =>
      share({ fileId: "f", type: "user", role: "writer", emailAddress: "hagelk@psd401.net" })
    ).not.toThrow()
    expect(() =>
      share({ fileId: "f", type: "user", role: "reader", emailAddress: "colleague@psd401.net" })
    ).not.toThrow()
    expect(() =>
      share({ fileId: "f", type: "domain", role: "reader", domain: "psd401.net" })
    ).not.toThrow()
  })

  it.each([
    ["public link", { fileId: "f", type: "anyone", role: "reader" }],
    ["group", { fileId: "f", type: "group", role: "reader", emailAddress: "staff@psd401.net" }],
    ["external address", { fileId: "f", type: "user", role: "reader", emailAddress: "evil@outside.com" }],
    ["lookalike domain", { fileId: "f", type: "user", role: "reader", emailAddress: "x@psd401.net.evil.com" }],
    ["external domain", { fileId: "f", type: "domain", role: "reader", domain: "gmail.com" }],
    ["domain-wide writer", { fileId: "f", type: "domain", role: "writer", domain: "psd401.net" }],
    ["ownership transfer", {
      fileId: "f", type: "user", role: "writer",
      emailAddress: "hagelk@psd401.net", transferOwnership: true,
    }],
    ["owner role", { fileId: "f", type: "user", role: "owner", emailAddress: "hagelk@psd401.net" }],
    ["unknown key", {
      fileId: "f", type: "user", role: "reader",
      emailAddress: "hagelk@psd401.net", unexpected: "x",
    }],
    ["missing role", { fileId: "f", type: "user", emailAddress: "hagelk@psd401.net" }],
    ["missing recipient", { fileId: "f", type: "user", role: "reader" }],
  ])("refuses %s", (_name, resource) => {
    expect(() => share(resource)).toThrow(/in-district/)
  })

  it("refuses a share with no parseable payload", () => {
    expect(() =>
      validateWorkspaceCommand({
        scope: "agent",
        argv: ["drive", "permissions", "create"],
      })
    ).toThrow(/in-district/)
  })
})
