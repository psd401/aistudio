import { describe, expect, test } from "bun:test";
import { buildAccountRequestBody } from "./account-request-payload";

describe("buildAccountRequestBody", () => {
  test("carries no owner selector because authority comes from the signed context", () => {
    const body = JSON.parse(buildAccountRequestBody()) as Record<string, unknown>;

    expect(body).toEqual({});
    expect(body).not.toHaveProperty("ownerEmail");
    expect(body).not.toHaveProperty("userEmail");
    expect(body).not.toHaveProperty("userId");
  });
});
