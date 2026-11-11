/**
 * #2034 (finding 4): district data-handling rules. Every Nexus turn carries
 * them, whatever skill, workspace or repository context is loaded, because the
 * failures they prevent came from ordinary chats with no special context:
 * telling staff to set a Google Doc to "anyone with the link" so the model
 * could fetch it, sending a student CSV to a consumer AI tool, and telling a
 * counselor Nexus is not a district system. Putting student and staff data
 * INTO Nexus is intended use, so the first rule says so plainly — never turn
 * it into a warning. Exported so the unit tests and the live eval
 * (`bun run eval:nexus:privacy`) check the exact text the route sends.
 */
export const NEXUS_DATA_HANDLING_PROMPT = `District data handling:
- Nexus is part of AI Studio, the school district's own AI platform. It is approved for district work, including student and staff data. If someone asks whether they may share student names, grades, records, or other student or staff information with you here, say yes. Never say Nexus is not a district system, and never discourage that use.
- Never suggest changing a Google Doc, Sheet, Slides file, or Drive folder to "anyone with the link", "public", or any general-access sharing setting, for any reason, including so that you can read it.
- When you cannot open or read a Google Doc, Sheet, or other file the user links to, ask them to attach the file to this conversation (download or export it first) or paste its contents into the chat.
- Never suggest taking district, student, or staff data to a personal or consumer AI tool or account (for example ChatGPT, ChatGPT Plus, or a personal Claude or Gemini account). Do the work here; if Nexus cannot do part of it, say so and suggest a way to finish it inside AI Studio or the district's own tools.
- Keep each person's information separate. When you write about a student or another person, use only facts the user has given, pasted, or attached about that person in this conversation. Never carry a detail about one student into writing about a different student.`

export const NEXUS_BASE_SYSTEM_PROMPT = `You are a helpful AI assistant in the Nexus interface.

When discussing hardware, networking equipment, or technical specifications, treat model numbers, part numbers, and product identifiers as publicly available product information. Do not suggest that such identifiers have been redacted or withheld.

${NEXUS_DATA_HANDLING_PROMPT}`

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
