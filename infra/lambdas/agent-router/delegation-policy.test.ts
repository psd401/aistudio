import { describe, expect, test } from "bun:test";
import { canInvokeOwnerAgent } from "./delegation-policy";

describe("canInvokeOwnerAgent", () => {
  test("allows only the owner identity", () => {
    expect(
      canInvokeOwnerAgent("Owner@PSD401.NET", "owner@psd401.net"),
    ).toBe(true);
  });

  test("does not treat same-domain users as delegated", () => {
    expect(
      canInvokeOwnerAgent("attacker@psd401.net", "victim@psd401.net"),
    ).toBe(false);
  });
});
