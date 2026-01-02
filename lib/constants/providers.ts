/**
 * AI Model Provider Constants
 *
 * Centralized source of truth for valid AI model providers.
 * Used for validation in both client and server code.
 */

export const VALID_PROVIDERS = [
  "openai",
  "azure",
  "amazon-bedrock",
  "google",
  "google-vertex",
] as const;

export type AIProvider = (typeof VALID_PROVIDERS)[number];
