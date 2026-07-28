const NEXUS_BASE_SYSTEM_PROMPT = `You are a helpful AI assistant in the Nexus interface.

When discussing hardware, networking equipment, or technical specifications, treat model numbers, part numbers, and product identifiers as publicly available product information. Do not suggest that such identifiers have been redacted or withheld.

IMPORTANT: If text contains privacy tokens like [PII:xxxx-xxxx-xxxx-xxxx], preserve them exactly as written. Do not modify, expand, or interpret these tokens.`

/**
 * Build the Nexus session system prompt from server-owned fragments.
 */
export function buildNexusSystemPrompt(input: {
  skillInstructions?: string
  skillName?: string
  workspacePromptFragment?: string
  hasAttachmentTools?: boolean
  repositoryPromptFragment?: string
  userMemoryFragment?: string
}): string {
  const {
    skillInstructions,
    skillName,
    workspacePromptFragment,
    hasAttachmentTools = false,
    repositoryPromptFragment,
    userMemoryFragment,
  } = input
  let prompt = NEXUS_BASE_SYSTEM_PROMPT
  if (skillInstructions) {
    prompt += `\n\n---\n\nThe user has loaded the skill "${skillName ?? "skill"}" into this session. Follow its instructions below for this conversation.\n\n${skillInstructions}`
  }
  if (workspacePromptFragment) {
    prompt += `\n\n---\n\n${workspacePromptFragment}`
  }
  if (hasAttachmentTools) {
    prompt +=
      "\n\n---\n\nThe user attached private repository content to this conversation. " +
      "Use searchNexusAttachments before making claims about those attachments. " +
      "Cite the returned source labels and never invent content that was not returned."
  }
  if (repositoryPromptFragment) {
    prompt += `\n\n---\n\n${repositoryPromptFragment}`
  }
  if (userMemoryFragment) {
    prompt += `\n\n---\n\n${userMemoryFragment}`
  }
  return prompt
}
