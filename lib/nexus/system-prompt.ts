const NEXUS_BASE_SYSTEM_PROMPT = `You are a helpful AI assistant in the Nexus interface.

When discussing hardware, networking equipment, or technical specifications, treat model numbers, part numbers, and product identifiers as publicly available product information. Do not suggest that such identifiers have been redacted or withheld.`

/**
 * Build the Nexus session system prompt from server-owned fragments.
 */
export function buildNexusSystemPrompt(input: {
  skillInstructions?: string
  skillName?: string
  workspacePromptFragment?: string
  /**
   * #1839: what the user's artifact preview failed with since their previous
   * message. Turn-scoped, unlike every other fragment here, and appended LAST:
   * it is the most perishable thing in the prompt and the model must act on it
   * this turn, so it must not be buried behind the repository/memory blocks by
   * a conversation that happens to have those too.
   */
  workspacePreviewDiagnosticsFragment?: string
  hasAttachmentTools?: boolean
  repositoryPromptFragment?: string
  userMemoryFragment?: string
}): string {
  const {
    skillInstructions,
    skillName,
    workspacePromptFragment,
    workspacePreviewDiagnosticsFragment,
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
  // #1839: LAST, and in its own `---` section rather than glued onto the
  // workspace fragment — it is the one turn-scoped block here, and the model must
  // act on it this turn, so later context must not bury it. It carries only
  // server-controlled values (count, kind, validated code), never artifact text.
  if (workspacePreviewDiagnosticsFragment) {
    prompt += `\n\n---\n\n${workspacePreviewDiagnosticsFragment}`
  }
  return prompt
}
