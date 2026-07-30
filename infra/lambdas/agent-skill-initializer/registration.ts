export interface SkillManifestEntry {
  name: string
  summary: string
  description?: string
  allowedTools?: string[]
  sourceHash: string
  imageTag: string
}

export interface BundledSkillRegistration {
  name: string
  summary: string
  s3Key: string
  allowedTools: string[]
}

const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/
const SAFE_IMAGE_TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/

/**
 * Convert the custom-resource manifest entry into the exact registry values
 * written by the initializer. Kept pure so storage and authorization metadata
 * stay regression-testable without loading AWS SDK clients.
 */
export function bundledSkillRegistration(
  skill: SkillManifestEntry,
  imageTag: string
): BundledSkillRegistration | null {
  if (
    !SAFE_SKILL_NAME.test(skill.name) ||
    !SAFE_IMAGE_TAG.test(imageTag) ||
    !skill.summary ||
    !skill.sourceHash
  ) {
    return null
  }

  return {
    name: skill.name,
    summary: skill.summary,
    s3Key: `skills/bundled/${imageTag}/${skill.name}`,
    allowedTools: Array.isArray(skill.allowedTools)
      ? skill.allowedTools.flatMap((tool) => {
          if (typeof tool !== "string") return []
          const normalized = tool.trim()
          return normalized ? [normalized] : []
        })
      : [],
  }
}
