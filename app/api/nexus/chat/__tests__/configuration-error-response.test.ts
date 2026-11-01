/**
 * #1849: an explicitly selected model whose provider credentials are missing
 * failed every turn with the generic "Failed to process chat request", shown to
 * the user as "An Error Occurred". The route now maps the adapters'
 * SYS_CONFIGURATION_ERROR to a distinct 503 with actionable guidance.
 */
import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorFactories } from "@/lib/error-utils";
import {
  PROVIDER_NOT_CONFIGURED_CODE,
  PROVIDER_NOT_CONFIGURED_MESSAGE,
  isProviderConfigurationError,
  providerConfigurationErrorResponse,
} from "../configuration-error-response";

describe("provider configuration error response (#1849)", () => {
  it("recognises the error the provider adapters throw for a missing key", () => {
    expect(
      isProviderConfigurationError(
        ErrorFactories.sysConfigurationError("OpenAI API key not configured")
      )
    ).toBe(true);
  });

  it("does not claim unrelated errors", () => {
    expect(isProviderConfigurationError(new Error("boom"))).toBe(false);
    expect(isProviderConfigurationError(ErrorFactories.sysInternalError("boom"))).toBe(false);
    expect(isProviderConfigurationError("SYS_CONFIGURATION_ERROR")).toBe(false);
    expect(isProviderConfigurationError(null)).toBe(false);
  });

  it("returns a 503 with an actionable message and no credential detail", async () => {
    const response = providerConfigurationErrorResponse("req-1849");
    expect(response.status).toBe(503);
    expect(response.headers.get("X-Request-Id")).toBe("req-1849");

    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: PROVIDER_NOT_CONFIGURED_MESSAGE,
      code: PROVIDER_NOT_CONFIGURED_CODE,
      requestId: "req-1849",
    });
    expect(body.error).not.toBe("Failed to process chat request");
    expect(String(body.error)).not.toMatch(/api key/i);
  });

  it("is checked in buildChatErrorResponse before the generic 500 fallthrough", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed path to the sibling route module.
    const source = readFileSync(join(__dirname, "..", "route.ts"), "utf8");
    const fnStart = source.indexOf("function buildChatErrorResponse(");
    expect(fnStart).toBeGreaterThan(-1);
    const fn = source.slice(fnStart);
    const configCheck = fn.indexOf("isProviderConfigurationError(error)");
    const genericFallthrough = fn.indexOf("'Failed to process chat request'");
    expect(configCheck).toBeGreaterThan(-1);
    expect(genericFallthrough).toBeGreaterThan(configCheck);
  });
});
