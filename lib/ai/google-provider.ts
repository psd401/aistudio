/**
 * One place that decides how the web app reaches Gemini.
 *
 * Deployed (ECS): Vertex AI with keyless WIF auth (lib/ai/google-vertex-wif.ts,
 * psd401/psd-gcp-infra vertex-ai.tf), standard 14. The Gemini API key in the
 * GOOGLE_API_KEY settings row is used only where the GOOGLE_VERTEX_* variables
 * are all unset, i.e. local development.
 */
import { createGoogleGenerativeAI, type GoogleGenerativeAIProvider } from '@ai-sdk/google';
import { createVertex, type GoogleVertexProvider } from '@ai-sdk/google-vertex';
import type { GoogleGenAIOptions } from '@google/genai';
import { Settings } from '@/lib/settings-manager';
import { ErrorFactories } from '@/lib/error-utils';
import { getVertexWifAuthClient, readVertexWifConfig } from '@/lib/ai/google-vertex-wif';

/**
 * Chat and image models. The Gemini 3.x previews and the Nano Banana image
 * models are served only from the global endpoint.
 */
export const VERTEX_GEMINI_LOCATION = 'global';

/** Gemini Live is not served from global; `us` is the US multi-region. */
export const VERTEX_LIVE_LOCATION = 'us';

export type GoogleModelProvider = GoogleGenerativeAIProvider | GoogleVertexProvider;

/**
 * True when Gemini can be called: Vertex WIF is configured, or (local dev) the
 * API key is set. Throws when Vertex is only partly configured.
 */
export async function isGoogleConfigured(): Promise<boolean> {
  if (readVertexWifConfig()) return true;
  const apiKey = await Settings.getGoogleAI();
  return Boolean(apiKey?.trim());
}

/** AI SDK provider for Gemini chat, Google Search grounding and image models. */
export async function createGoogleModelProvider(): Promise<GoogleModelProvider> {
  const vertex = readVertexWifConfig();
  if (vertex) {
    return createVertex({
      project: vertex.projectId,
      location: VERTEX_GEMINI_LOCATION,
      googleAuthOptions: { authClient: getVertexWifAuthClient(vertex) },
    });
  }
  const apiKey = await Settings.getGoogleAI();
  if (!apiKey) {
    throw ErrorFactories.sysConfigurationError('Google API key not configured');
  }
  // Scope the DB-sourced key to this client instead of mutating process.env
  // (REV-COR-505 / REV-REF-034).
  return createGoogleGenerativeAI({ apiKey });
}

/** @google/genai client options, e.g. for Gemini Live. */
export async function getGoogleGenAIOptions(vertexLocation: string): Promise<GoogleGenAIOptions> {
  const vertex = readVertexWifConfig();
  if (vertex) {
    return {
      vertexai: true,
      project: vertex.projectId,
      location: vertexLocation,
      googleAuthOptions: { authClient: getVertexWifAuthClient(vertex) },
    };
  }
  const apiKey = await Settings.getGoogleAI();
  if (!apiKey) {
    throw ErrorFactories.sysConfigurationError('Google API key not configured');
  }
  return { apiKey };
}
