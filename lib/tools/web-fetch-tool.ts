/**
 * `web_fetch` — the universal AI SDK chat tool that opens a single URL.
 *
 * Issue #1696 / FS#164087 (and FS#164086): Nexus chat's only internet-facing
 * tool was provider-native web SEARCH, which cannot open a specific link, so
 * pasting a URL produced "I cannot access URLs directly". Worse, web search is
 * provider-native and Bedrock/Claude and Azure expose none at all
 * (`createBedrockNativeTools()` returns `{}`), leaving those models with no web
 * capability whatsoever.
 *
 * This tool closes both gaps at once because it runs IN PROCESS rather than in
 * the provider: registering it in `createUniversalTools()` makes it available on
 * every provider — OpenAI, Google, Azure and Bedrock/Claude alike.
 *
 * The network behaviour is NOT reimplemented here. It delegates to
 * `fetchWebPageText`, the same SSRF-guarded core the agentic Assistant Architect
 * runtime uses (HTTPS-only in production; private/loopback/link-local/cloud
 * metadata hosts blocked, including through redirects and DNS rebinding;
 * 5 MB / 10 s / 5-redirect ceilings; text-ish content types only).
 */

import type { Tool } from "ai";
import { jsonSchema } from "ai";
import { fetchWebPageText } from "@/lib/agents/agent-tools/web-fetch";

export interface WebFetchToolArgs {
  url: string;
  maxChars?: number;
}

export interface WebFetchToolResult {
  /** The URL actually fetched (post-guard), when the input was usable. */
  url?: string;
  /** Upstream HTTP status, when a response was received. */
  status?: number;
  /** False when the page could not be retrieved; `content` explains why. */
  ok: boolean;
  /** Readable page text, or the failure reason when `ok` is false. */
  content: string;
}

const WEB_FETCH_TOOL_DESCRIPTION = `Open a specific web page by URL and read its text content.

Use this whenever the user pastes or names a URL, or asks you to read, check, summarize, quote or follow a link. Do NOT reply that you cannot access URLs or browse the web — call this tool instead.

Also use it to open a promising link you found via web search when the search snippet alone is not enough to answer accurately.

Returns the page's readable text with scripts, styles and markup stripped. Only public http(s) pages are reachable; private, internal and cloud-metadata addresses are refused. Very long pages are truncated — raise maxChars (up to 100000) when you need more, and tell the user when a result was truncated.

If a fetch fails, report the actual reason to the user (for example a 404, a timeout, or a site that blocks automated access) rather than claiming you are unable to access URLs in general.`;

function createWebFetchSchema() {
  return jsonSchema<WebFetchToolArgs>({
    type: "object",
    properties: {
      url: {
        type: "string",
        description:
          'Absolute http(s) URL of the page to open, e.g. "https://example.com/article".',
      },
      maxChars: {
        type: "number",
        description:
          "Optional cap on returned characters (default 20000, maximum 100000).",
      },
    },
    required: ["url"],
  });
}

/**
 * Build the `web_fetch` tool for the AI SDK chat surface.
 *
 * Registered unconditionally by `createUniversalTools()`, exactly like
 * `show_chart`: reading a link the user pasted is baseline chat behaviour, not
 * an opt-in mode, and a user who pastes a URL has no way to know they were
 * supposed to flip a toggle first. Every role that can reach the chat route
 * already holds `chat:write` (`ROLE_SCOPES` in `lib/api-keys/scopes.ts` grants
 * it to student, staff and administrator alike), so no scope check here could
 * change the outcome for any caller.
 */
export function createWebFetchTool(): Tool<WebFetchToolArgs, WebFetchToolResult> {
  return {
    description: WEB_FETCH_TOOL_DESCRIPTION,
    inputSchema: createWebFetchSchema(),
    execute: async (args: WebFetchToolArgs): Promise<WebFetchToolResult> => {
      const outcome = await fetchWebPageText(args?.url, args?.maxChars, {
        action: "chat.web_fetch",
      });
      return {
        ...(outcome.url ? { url: outcome.url } : {}),
        ...(outcome.status !== undefined ? { status: outcome.status } : {}),
        ok: !outcome.isError,
        content: outcome.text,
      };
    },
  };
}
