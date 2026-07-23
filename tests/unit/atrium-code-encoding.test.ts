/**
 * Unit tests for `decodeContentBody` — the WAF-opaque base64 transit decoder for
 * Atrium content bodies (artifact code / document markdown).
 *
 * The edge WAF (AWSManagedRulesCommonRuleSet → CrossSiteScripting_BODY) blocks any
 * raw request body containing <script>/<style>/style="…" — exactly what a real
 * artifact carries. The content-write surfaces therefore accept the body
 * base64-encoded (inert to the WAF) and decode it HERE, before §28.3 screening and
 * the size caps run. These tests pin:
 *   - a valid base64 body decodes to its exact UTF-8 content,
 *   - an undefined `codeEncoding` passes the body through unchanged (raw contract),
 *   - invalid / non-canonical / oversized base64 throws a ValidationError (→ 400),
 *   - the encoded form of <script>-bearing code is WAF-opaque (no XSS signature).
 */

import {
  decodeContentBody,
  MAX_DECODED_BODY_BYTES,
} from "@/lib/content/code-encoding";
import { ValidationError } from "@/lib/content/errors";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("decodeContentBody", () => {
  it("passes the body through unchanged when no encoding is set", () => {
    expect(decodeContentBody("<script>raw</script>", undefined)).toBe(
      "<script>raw</script>"
    );
    expect(decodeContentBody(undefined, undefined)).toBeUndefined();
  });

  it("decodes a valid base64 body to its exact UTF-8 content", () => {
    const code = '<html><style>b{color:red}</style><script>alert("héllo 日本")</script></html>';
    expect(decodeContentBody(b64(code), "base64")).toBe(code);
  });

  it("the base64 wrapper carries no XSS signature (WAF-opaque)", () => {
    const encoded = b64("<script>alert(1)</script>");
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(encoded).not.toContain("<");
    expect(encoded).not.toContain("<script");
  });

  it("throws a ValidationError (400) when codeEncoding is set but no body is given", () => {
    expect(() => decodeContentBody(undefined, "base64")).toThrow(ValidationError);
  });

  it("rejects an unsupported encoding value that bypasses the schema (cast)", () => {
    // A caller that slips a non-"base64" value past the zod enum via a cast must
    // be rejected at the boundary, not silently decoded as base64.
    const bad = "gzip" as unknown as Parameters<typeof decodeContentBody>[1];
    expect(() => decodeContentBody("aGVsbG8=", bad)).toThrow(ValidationError);
  });

  it("throws on a raw (non-base64) body that slipped past a mis-set flag", () => {
    // Contains `<`, spaces — not base64; would otherwise decode to garbage.
    expect(() => decodeContentBody("<script>not base64</script>", "base64")).toThrow(
      ValidationError
    );
  });

  it("throws on a wrong-length / non-canonical base64 string", () => {
    // Length not a multiple of 4.
    expect(() => decodeContentBody("YWJj YQ", "base64")).toThrow(ValidationError);
    // Padding is only valid in the final one or two positions.
    expect(() => decodeContentBody("YW=J", "base64")).toThrow(ValidationError);
    // All-padding degenerate input decodes to nothing.
    expect(() => decodeContentBody("====", "base64")).toThrow(ValidationError);
    // Empty / whitespace.
    expect(() => decodeContentBody("   ", "base64")).toThrow(ValidationError);
  });

  it("enforces the decoded-size cap without regexp stack exhaustion", () => {
    const tooBig = b64("x".repeat(MAX_DECODED_BODY_BYTES + 1));
    let oversizedError: unknown;
    try {
      decodeContentBody(tooBig, "base64");
    } catch (error) {
      oversizedError = error;
    }
    expect(oversizedError).toBeInstanceOf(ValidationError);
    expect(oversizedError).toMatchObject({
      message: `Decoded content exceeds the ${MAX_DECODED_BODY_BYTES}-byte limit`,
    });
    // A body exactly at the cap is accepted.
    const atCap = b64("x".repeat(MAX_DECODED_BODY_BYTES));
    expect(decodeContentBody(atCap, "base64")).toHaveLength(MAX_DECODED_BODY_BYTES);
  });
});
