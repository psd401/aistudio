import { Buffer } from "node:buffer"
import workspacePolicy from "@/lib/agent-workspace/workspace-policy.json"

export type WorkspacePathRejectionReason =
  | "empty"
  | "absolute"
  | "trailing-slash"
  | "too-long"
  | "too-deep"
  | "empty-segment"
  | "traversal-segment"
  | "segment-too-long"
  | "unsupported-character"

const PRIVATE_PATH_POLICY = workspacePolicy.privatePath
const CHECKPOINT_EXCLUSIONS = workspacePolicy.checkpointExclusions
const EXCLUDED_BASENAMES = new Set(CHECKPOINT_EXCLUSIONS.basenames)
const EXCLUDED_SEGMENT_NAMES = new Set(CHECKPOINT_EXCLUSIONS.segmentNames)
const EXACT_VENV_SEGMENTS = new Set(
  CHECKPOINT_EXCLUSIONS.exactVenvSegments,
)
const EXCLUDED_BASENAME_PATTERNS =
  CHECKPOINT_EXCLUSIONS.basenamePatterns.map(
    // Patterns come only from the versioned, source-controlled policy file.
    // eslint-disable-next-line security/detect-non-literal-regexp
    (pattern) => new RegExp(pattern),
  )

function containsRejectedCodePoint(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (
      codePoint === undefined ||
      PRIVATE_PATH_POLICY.rejectedCodePointRanges.some(
        ([start, end]) => codePoint >= start && codePoint <= end,
      )
    ) {
      return true
    }
  }
  return false
}

/**
 * Canonical private-workspace path contract shared with workspace_sync.py.
 * It accepts ordinary POSIX punctuation and Unicode literally; safety comes
 * from structural traversal bounds and no-follow filesystem operations, not
 * a shell-oriented filename allowlist.
 */
export function workspaceRelativePathRejectionReason(
  relativePath: string,
): WorkspacePathRejectionReason | null {
  if (!relativePath) return "empty"
  if (relativePath.startsWith("/")) return "absolute"
  if (relativePath.endsWith("/")) return "trailing-slash"
  if (
    Buffer.byteLength(relativePath, "utf8") >
    PRIVATE_PATH_POLICY.maxUtf8Bytes
  ) {
    return "too-long"
  }
  if (containsRejectedCodePoint(relativePath)) {
    return "unsupported-character"
  }

  const segments = relativePath.split("/")
  if (segments.length > PRIVATE_PATH_POLICY.maxDepth) return "too-deep"
  for (const segment of segments) {
    if (!segment) return "empty-segment"
    if (segment === "." || segment === "..") {
      return "traversal-segment"
    }
    if (
      Buffer.byteLength(segment, "utf8") >
      PRIVATE_PATH_POLICY.maxSegmentUtf8Bytes
    ) {
      return "segment-too-long"
    }
  }
  return null
}

export function validateWorkspaceRelativePath(relativePath: string): string {
  if (workspaceRelativePathRejectionReason(relativePath)) {
    throw new Error("Invalid workspace-relative path")
  }
  return relativePath
}

function isRegenerableSegment(segment: string): boolean {
  if (
    EXCLUDED_SEGMENT_NAMES.has(segment) ||
    EXACT_VENV_SEGMENTS.has(segment)
  ) {
    return true
  }
  return (
    segment.startsWith(".") &&
    segment.endsWith(CHECKPOINT_EXCLUSIONS.hiddenVenvSuffix)
  )
}

/** Paths intentionally excluded by the runtime in both pull and push. */
export function isWorkspaceCheckpointExcluded(relativePath: string): boolean {
  const relative = relativePath.replace(/^\/+/, "")
  if (
    CHECKPOINT_EXCLUSIONS.relativePrefixes.some(
      (prefix) => relative === prefix || relative.startsWith(prefix),
    )
  ) {
    return true
  }
  const segments = relative.split("/")
  const basename = segments.at(-1) ?? ""
  return (
    EXCLUDED_BASENAMES.has(basename) ||
    EXCLUDED_BASENAME_PATTERNS.some((pattern) => pattern.test(basename)) ||
    segments.some(isRegenerableSegment) ||
    CHECKPOINT_EXCLUSIONS.suffixes.some((suffix) =>
      relative.endsWith(suffix),
    )
  )
}

export function isCheckpointManagedWorkspacePath(
  relativePath: string,
): boolean {
  return (
    relativePath !== "attachments" &&
    !relativePath.startsWith("attachments/") &&
    !isWorkspaceCheckpointExcluded(relativePath)
  )
}
