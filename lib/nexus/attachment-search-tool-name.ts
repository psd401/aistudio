/**
 * The model-facing name of the Nexus attachment search tool.
 *
 * Defined once, dependency-free, because the router, the chat route and the
 * history helpers all branch on it: a rename that missed one copy would
 * compile cleanly and silently route attachment image requests to a text
 * model again (#1900).
 */
export const NEXUS_ATTACHMENT_SEARCH_TOOL_NAME = "searchNexusAttachments";
