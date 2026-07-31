import contractCases from "@/infra/agent-image/workspace_path_contract_cases.json"
import {
  isCheckpointManagedWorkspacePath,
  validateWorkspaceRelativePath,
  workspaceRelativePathRejectionReason,
} from "@/lib/agent-workspace/path-policy"

describe("canonical private workspace path policy", () => {
  it.each(contractCases.valid)("accepts %s", (path) => {
    expect(validateWorkspaceRelativePath(path)).toBe(path)
    expect(workspaceRelativePathRejectionReason(path)).toBeNull()
  })

  it.each(contractCases.invalid)(
    "rejects $reason for $path",
    ({ path, reason }) => {
      expect(workspaceRelativePathRejectionReason(path)).toBe(reason)
      expect(() => validateWorkspaceRelativePath(path)).toThrow(
        "Invalid workspace-relative path",
      )
    },
  )

  it("applies UTF-8 byte, segment, and depth bounds", () => {
    expect(workspaceRelativePathRejectionReason("a".repeat(769))).toBe(
      "too-long",
    )
    expect(
      workspaceRelativePathRejectionReason(`${"a".repeat(256)}/file`),
    ).toBe("segment-too-long")
    expect(
      workspaceRelativePathRejectionReason(
        Array.from({ length: 65 }, () => "a").join("/"),
      ),
    ).toBe("too-deep")
    expect(workspaceRelativePathRejectionReason("é".repeat(385))).toBe(
      "too-long",
    )
    expect(
      workspaceRelativePathRejectionReason(
        `surrogate-${String.fromCharCode(0xD800)}`,
      ),
    ).toBe("unsupported-character")
  })

  it("shares checkpoint exclusions with the image runtime", () => {
    expect(
      isCheckpointManagedWorkspacePath(
        "skills/example/.tts-venv/lib/site-packages/pkg/file.py",
      ),
    ).toBe(false)
    expect(isCheckpointManagedWorkspacePath("node_modules/pkg/index.js")).toBe(
      false,
    )
    expect(isCheckpointManagedWorkspacePath("memory/notes (v2).md")).toBe(true)
  })
})
