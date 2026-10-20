/**
 * buildNexusStreamHeaders — shared header builder for the streaming,
 * deep-research and image-generation responses in the Nexus chat route.
 */
import { describe, it, expect } from "@jest/globals";
import {
  buildNexusStreamHeaders,
  MAX_NEXUS_ROUTING_HEADER_LENGTH,
} from "../stream-headers";

const routingMetadata = { routedModelId: "gemini-deep-research", reason: "deep" };
const encodedRouting = encodeURIComponent(JSON.stringify(routingMetadata));

describe("buildNexusStreamHeaders", () => {
  describe("deep-research path", () => {
    it("builds the same headers as before for a new conversation", () => {
      const headers = buildNexusStreamHeaders({
        requestId: "req-1",
        routingMetadata,
        conversationId: "conv-1",
        conversationTitle: "Research: tides & moon",
        extraHeaders: { "X-Deep-Research": "true" },
      });

      expect(headers).toEqual({
        "X-Request-Id": "req-1",
        "X-Conversation-Id": "conv-1",
        "X-Deep-Research": "true",
        "X-Nexus-Routing": encodedRouting,
        "X-Conversation-Title": encodeURIComponent("Research: tides & moon"),
      });
    });

    it("omits X-Conversation-Title for an existing conversation", () => {
      const headers = buildNexusStreamHeaders({
        requestId: "req-1",
        routingMetadata,
        conversationId: "conv-1",
        extraHeaders: { "X-Deep-Research": "true" },
      });

      expect(headers["X-Conversation-Id"]).toBe("conv-1");
      expect(headers).not.toHaveProperty("X-Conversation-Title");
    });

    it("drops X-Nexus-Routing when the encoded value exceeds the cap", () => {
      const oversized = { reason: "x".repeat(MAX_NEXUS_ROUTING_HEADER_LENGTH) };
      const headers = buildNexusStreamHeaders({
        requestId: "req-1",
        routingMetadata: oversized,
        conversationId: "conv-1",
        extraHeaders: { "X-Deep-Research": "true" },
      });

      expect(headers).not.toHaveProperty("X-Nexus-Routing");
      expect(headers).toEqual({
        "X-Request-Id": "req-1",
        "X-Conversation-Id": "conv-1",
        "X-Deep-Research": "true",
      });
    });
  });

  it("keeps X-Nexus-Routing at exactly the cap length", () => {
    const overhead = encodeURIComponent(JSON.stringify({ r: "" })).length;
    const atCap = { r: "a".repeat(MAX_NEXUS_ROUTING_HEADER_LENGTH - overhead) };
    const encoded = encodeURIComponent(JSON.stringify(atCap));
    expect(encoded.length).toBe(MAX_NEXUS_ROUTING_HEADER_LENGTH);

    const headers = buildNexusStreamHeaders({ requestId: "req-1", routingMetadata: atCap });
    expect(headers["X-Nexus-Routing"]).toBe(encoded);
  });

  it("builds image-generation headers and skips routing when none is given", () => {
    const headers = buildNexusStreamHeaders({
      requestId: "req-2",
      conversationId: "conv-2",
      conversationTitle: "New image",
      extraHeaders: { "X-Image-Generated": "true" },
    });

    expect(headers).toEqual({
      "X-Request-Id": "req-2",
      "X-Conversation-Id": "conv-2",
      "X-Image-Generated": "true",
      "X-Conversation-Title": encodeURIComponent("New image"),
    });
  });

  it("builds streaming headers without conversation headers for an existing conversation", () => {
    const headers = buildNexusStreamHeaders({
      requestId: "req-3",
      routingMetadata,
      extraHeaders: {
        "X-Unified-Streaming": "true",
        "X-Supports-Reasoning": "false",
      },
    });

    expect(headers).toEqual({
      "X-Request-Id": "req-3",
      "X-Unified-Streaming": "true",
      "X-Supports-Reasoning": "false",
      "X-Nexus-Routing": encodedRouting,
    });
  });
});
