/** @jest-environment node */

import { describe, expect, it } from "@jest/globals";
import {
  BoundedJsonRequestError,
  parseBoundedJsonRequest,
} from "@/lib/api/bounded-json-request";

function jsonRequest(
  body: string,
  contentLength?: string,
): {
  body: ReadableStream<Uint8Array>;
  headers: Headers;
} {
  const bytes = new TextEncoder().encode(body);
  return {
    headers: new Headers({
      "Content-Type": "application/json",
      ...(contentLength === undefined
        ? {}
        : { "Content-Length": contentLength }),
    }),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

describe("parseBoundedJsonRequest", () => {
  it("parses a body without Content-Length while counting the stream", async () => {
    const request = jsonRequest('{"value":"ok"}');

    expect(request.headers.get("content-length")).toBeNull();
    await expect(parseBoundedJsonRequest(request, 32)).resolves.toEqual({
      value: "ok",
    });
  });

  it("rejects a streamed body over the cap when Content-Length is absent", async () => {
    const request = jsonRequest(`{"value":"${"x".repeat(64)}"}`);

    await expect(parseBoundedJsonRequest(request, 32)).rejects.toMatchObject({
      name: "BoundedJsonRequestError",
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
    } satisfies Partial<BoundedJsonRequestError>);
  });

  it("does not trust an understated Content-Length", async () => {
    const request = jsonRequest(`{"value":"${"x".repeat(64)}"}`, "2");

    await expect(parseBoundedJsonRequest(request, 32)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
    });
  });

  it("rejects a declared length over the cap before accepting the body", async () => {
    const request = jsonRequest('{"value":"ok"}', "33");

    await expect(parseBoundedJsonRequest(request, 32)).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      status: 413,
    });
  });

  it("rejects malformed JSON inside the cap", async () => {
    const request = jsonRequest("{not-json");

    await expect(parseBoundedJsonRequest(request, 32)).rejects.toMatchObject({
      code: "INVALID_JSON",
      status: 400,
    });
  });

  it("returns the configured value for an optional empty body", async () => {
    const request = jsonRequest("", "0");

    await expect(
      parseBoundedJsonRequest(request, 32, { emptyBodyValue: {} }),
    ).resolves.toEqual({});
  });
});
