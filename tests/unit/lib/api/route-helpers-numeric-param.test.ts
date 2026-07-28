import { describe, expect, it } from "@jest/globals";
import { extractNumericParam } from "@/lib/api/route-helpers";

describe("extractNumericParam", () => {
  it.each([
    ["http://localhost/api/v1/assistants/12", 12],
    ["http://localhost/api/v1/assistants/12/fork", 12],
    ["http://localhost/api/v1/assistants/12junk", null],
    ["http://localhost/api/v1/assistants/0", null],
    ["http://localhost/api/v1/assistants/-1", null],
    ["http://localhost/api/v1/assistants/9007199254740992", null],
  ])("parses only a complete positive safe integer in %s", (url, expected) => {
    expect(extractNumericParam(url, "assistants")).toBe(expected);
  });
});
