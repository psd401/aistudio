/**
 * Shared response-header builder for Nexus chat stream responses.
 *
 * The normal streaming path, the deep-research path and the image-generation
 * path all return a UI message stream with the same core headers. Building them
 * in one place keeps the X-Nexus-Routing size cap applied everywhere — an
 * oversized header can make the response fail before the stream reaches the
 * browser.
 */

/** Max length of the URL-encoded X-Nexus-Routing value; larger values are dropped. */
export const MAX_NEXUS_ROUTING_HEADER_LENGTH = 4096;

export interface NexusStreamHeaderParams {
  requestId: string;
  /** Routing metadata for X-Nexus-Routing; omitted when undefined or oversized. */
  routingMetadata?: object;
  /** Sets X-Conversation-Id when provided. */
  conversationId?: string;
  /** Sets the URL-encoded X-Conversation-Title when provided. */
  conversationTitle?: string;
  /** Call-site specific headers (e.g. X-Deep-Research, X-Image-Generated). */
  extraHeaders?: Record<string, string>;
}

export function buildNexusStreamHeaders(
  params: NexusStreamHeaderParams,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Request-Id": params.requestId,
    ...params.extraHeaders,
  };
  if (params.routingMetadata !== undefined) {
    const encodedRouting = encodeURIComponent(
      JSON.stringify(params.routingMetadata),
    );
    if (encodedRouting.length <= MAX_NEXUS_ROUTING_HEADER_LENGTH) {
      headers["X-Nexus-Routing"] = encodedRouting;
    }
  }
  if (params.conversationId !== undefined) {
    headers["X-Conversation-Id"] = params.conversationId;
  }
  if (params.conversationTitle !== undefined) {
    headers["X-Conversation-Title"] = encodeURIComponent(
      params.conversationTitle,
    );
  }
  return headers;
}
