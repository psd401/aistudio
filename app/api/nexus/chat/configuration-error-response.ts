/**
 * Maps a provider-configuration failure to a distinct Nexus chat response.
 *
 * Provider adapters throw `ErrorFactories.sysConfigurationError(...)` when a
 * model's provider credentials are missing or invalid (e.g. "OpenAI API key not
 * configured"). An explicitly selected model keeps that error instead of being
 * rerouted, and before #1849 it fell through to the generic 500 "Failed to
 * process chat request", which users saw as "An Error Occurred" on every turn
 * with no hint that a different model would work.
 *
 * The technical message is logged, never returned: it names the missing
 * credential, which is operator detail, not user guidance.
 */

import { ErrorCode, type TypedError } from "@/types/error-types";

export const PROVIDER_NOT_CONFIGURED_CODE = "PROVIDER_NOT_CONFIGURED";

export const PROVIDER_NOT_CONFIGURED_MESSAGE =
  "This model isn't available right now because its AI provider isn't set up. " +
  "Switch to Standard mode or another model family, and let an administrator know.";

export function isProviderConfigurationError(error: unknown): error is TypedError {
  return (
    error instanceof Error &&
    (error as Partial<TypedError>).code === ErrorCode.SYS_CONFIGURATION_ERROR
  );
}

export function providerConfigurationErrorResponse(requestId: string): Response {
  return new Response(
    JSON.stringify({
      error: PROVIDER_NOT_CONFIGURED_MESSAGE,
      code: PROVIDER_NOT_CONFIGURED_CODE,
      requestId,
    }),
    {
      status: 503,
      headers: { "Content-Type": "application/json", "X-Request-Id": requestId },
    }
  );
}
