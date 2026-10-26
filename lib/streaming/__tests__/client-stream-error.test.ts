/**
 * #1966: a Firefox user saw "Error in input stream" — the browser's own text for a
 * response body cut off mid-read — rendered verbatim in the chat thread.
 */
import { describe, it, expect } from "@jest/globals";
import {
  STREAM_INTERRUPTED_MESSAGE,
  isBrowserTransportFailure,
  toDisplayableChatError,
} from "../client-stream-error";
import { STREAM_ERROR_MESSAGES } from "../stream-error-message";

describe("toDisplayableChatError (#1966)", () => {
  it.each([
    new TypeError("Error in input stream"), // Firefox mid-read truncation (the report)
    new TypeError("NetworkError when attempting to fetch resource."), // Firefox
    new TypeError("network error"), // Chrome mid-stream
    new TypeError("Failed to fetch"), // Chrome
    new TypeError("Load failed"), // Safari
    "The network connection was lost.",
    new TypeError("terminated"), // undici
    "net::ERR_INCOMPLETE_CHUNKED_ENCODING",
    "TypeError: Failed to fetch",
  ])("replaces the browser transport failure %p with the sanitized message", error => {
    expect(isBrowserTransportFailure(error)).toBe(true);
    expect(toDisplayableChatError(error)).toBe(STREAM_INTERRUPTED_MESSAGE);
  });

  it("passes the server's sanitized stream errors through unchanged", () => {
    for (const message of Object.values(STREAM_ERROR_MESSAGES)) {
      expect(toDisplayableChatError(new Error(message))).toBe(message);
    }
  });

  it("passes other app-authored messages through unchanged", () => {
    const message = "Session expired. Please sign in again.";
    expect(toDisplayableChatError(new Error(message))).toBe(message);
    expect(toDisplayableChatError("The session was terminated by an administrator.")).toBe(
      "The session was terminated by an administrator."
    );
  });

  it.each([
    "Upload failed",
    "The file could not be processed because of a network error on the storage service.",
    "Image download failed to fetch the source URL.",
  ])("keeps app-authored text that merely contains a transport phrase: %p", message => {
    expect(isBrowserTransportFailure(message)).toBe(false);
    expect(toDisplayableChatError(new Error(message))).toBe(message);
  });

  it("never returns the raw transport text", () => {
    expect(toDisplayableChatError(new TypeError("Error in input stream"))).not.toMatch(
      /input stream/i
    );
  });
});
