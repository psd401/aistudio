import { NEXUS_ATTACHMENT_SEARCH_TOOL_NAME } from "@/lib/nexus/attachment-search-tool-name";

/**
 * The tools a turn's routing must honour, and which of them are present only
 * because of a Project, Skill or Assistant binding.
 *
 * A bound conversation adds its repository search tools to EVERY turn, so
 * they say nothing about what this request needs. The router treats those
 * binding-only tools as satisfied for an image request: otherwise "draw a cat"
 * in a Project conversation counts as a tool turn and goes to a text model,
 * which cannot produce an image at all. A repository the user chose directly
 * (a `direct` binding or this request's `repositoryIds`), and any tool the user
 * enabled by hand, is never binding-only.
 */
export function splitRoutingToolNames(input: {
  enabledTools: string[];
  requiresAttachmentTools: boolean;
  hasDurableRepositoryBinding: boolean;
  hasUserChosenRepository: boolean;
  hasProjectBinding: boolean;
  hasSkillBinding: boolean;
}): { tools: string[]; bindingTools: string[] } {
  const projectTools = input.hasProjectBinding ? ["searchProjectRepositories"] : [];
  const skillTools = input.hasSkillBinding ? ["searchSkillRepositories"] : [];
  const conversationTools = input.hasDurableRepositoryBinding
    ? ["searchConversationRepositories"]
    : [];
  const tools = [
    ...new Set([
      ...input.enabledTools,
      ...(input.requiresAttachmentTools ? [NEXUS_ATTACHMENT_SEARCH_TOOL_NAME] : []),
      ...conversationTools,
      ...projectTools,
      ...skillTools,
    ]),
  ];
  const bindingTools = [
    ...(input.hasUserChosenRepository ? [] : conversationTools),
    ...projectTools,
    ...skillTools,
  ].filter((tool) => !input.enabledTools.includes(tool));
  return { tools, bindingTools };
}
