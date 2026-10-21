import { NEXUS_ATTACHMENT_SEARCH_TOOL_NAME } from "@/lib/nexus/attachment-search-tool-name";

/**
 * The tools a turn's routing must honour, and which of them are present only
 * because of a Project, Skill or Assistant binding.
 *
 * A bound conversation adds its repository search tools to EVERY turn, so
 * they say nothing about what this request needs. The router treats those
 * binding-only tools as satisfied for an image request: otherwise "draw a cat"
 * in a Project conversation counts as a tool turn and goes to a text model,
 * which cannot produce an image at all. A repository the user chose directly,
 * and any tool the user enabled by hand, is never binding-only.
 *
 * A Skill's pinned `allowed-tools` reach the request as `enabledTools` (the
 * "Use in chat" link serializes them), so they look hand-picked. They are
 * the Skill's, not this request's: `skillPinnedTools` (from the approved
 * skill record, never the URL) marks them binding-only too.
 *
 * Known limitation (accepted for PR #1950): the request carries tool names,
 * not where they came from, so a tool the user ALSO picked by hand that the
 * Skill pins is indistinguishable from the pin and is dropped on an image
 * turn. Telling them apart needs the client to send provenance.
 *
 * "Chose directly" is this request's picker selection when the client sent
 * one — it replaces the stored `direct` binding later in the turn, so an EMPTY
 * selection means the user just cleared it. The stored `direct` binding
 * decides only when the request carries no selection.
 */
export function splitRoutingToolNames(input: {
  enabledTools: string[];
  requiresAttachmentTools: boolean;
  hasDurableRepositoryBinding: boolean;
  requestedRepositoryIds: number[] | undefined;
  hasStoredDirectBinding: boolean;
  hasProjectBinding: boolean;
  hasSkillBinding: boolean;
  /** The approved Skill's `allowed-tools`; empty with no Skill. */
  skillPinnedTools: string[];
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
  const hasUserChosenRepository =
    input.requestedRepositoryIds !== undefined
      ? input.requestedRepositoryIds.length > 0
      : input.hasStoredDirectBinding;
  const skillPinned = new Set(input.skillPinnedTools);
  const handPicked = new Set(
    input.enabledTools.filter((tool) => !skillPinned.has(tool))
  );
  const bindingTools = [
    ...new Set([
      ...(hasUserChosenRepository ? [] : conversationTools),
      ...projectTools,
      ...skillTools,
      ...input.enabledTools.filter((tool) => skillPinned.has(tool)),
    ]),
  ].filter((tool) => !handPicked.has(tool));
  return { tools, bindingTools };
}
