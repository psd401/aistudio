import {
  outboundMessageAudit,
  requiredWorkspaceScopeGap,
  validateEmailTaskWorkspaceCommand,
  validateWorkspaceCommand,
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

function defineTrustedWorkspaceCommandPolicySuite1Part2() {it.each([
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
    ["drive", "permissions", "create"],
    ["sheets", "spreadsheets", "batchUpdate"],
    ["slides", "presentations", "batchUpdate"],
    ["tasks", "tasks", "patch"],
    ["tasks", "tasks", "update"],
  ])("denies %s %s %s without server-recorded provenance", (...argv) => {
    expect(() =>
      validateWorkspaceCommand({ scope: "agent", argv })
    ).toThrow(/server-recorded agent-created provenance/)
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
}

const defineTrustedWorkspaceCommandPolicySuite1 = () => {
  defineTrustedWorkspaceCommandPolicySuite1Part1()
  defineTrustedWorkspaceCommandPolicySuite1Part2()
  defineTrustedWorkspaceCommandPolicySuite1Part3()
};

describe("trusted Workspace command policy", defineTrustedWorkspaceCommandPolicySuite1)

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
};

describe("Workspace outbound message audit", defineWorkspaceOutboundAuditSuite4)
