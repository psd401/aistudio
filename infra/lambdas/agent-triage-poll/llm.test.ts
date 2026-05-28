/**
 * Unit tests for parseLLMOutput. The Bedrock call itself is integration
 * territory — these tests just cover the parser's tolerance for the
 * various shapes Nova Micro is known to emit (markdown-wrapped JSON,
 * stray prose, trailing punctuation).
 */
import { describe, expect, test } from "bun:test";
import { parseLLMOutput } from "./llm";

describe("parseLLMOutput", () => {
  test("clean JSON line", () => {
    expect(
      parseLLMOutput('{"label":"important","confidence":0.92,"reason":"direct human ask"}'),
    ).toEqual({
      label: "important",
      confidence: 0.92,
      reason: "direct human ask",
    });
  });

  test("markdown-fenced JSON", () => {
    expect(
      parseLLMOutput(
        '```json\n{"label":"later","confidence":0.6,"reason":"newsletter"}\n```',
      ),
    ).toEqual({ label: "later", confidence: 0.6, reason: "newsletter" });
  });

  test("trailing period after closing brace", () => {
    expect(
      parseLLMOutput('{"label":"news","confidence":0.8,"reason":"vendor blast"}.'),
    ).toEqual({ label: "news", confidence: 0.8, reason: "vendor blast" });
  });

  test("prepended prose then JSON object", () => {
    expect(
      parseLLMOutput('Here is the answer: {"label":"important","confidence":0.7,"reason":"PR review"}'),
    ).toEqual({ label: "important", confidence: 0.7, reason: "PR review" });
  });

  test("invalid label falls back to later", () => {
    expect(
      parseLLMOutput('{"label":"urgent","confidence":0.9,"reason":"x"}'),
    ).toMatchObject({ label: "later" });
  });

  test("out-of-range confidence falls back to 0", () => {
    expect(
      parseLLMOutput('{"label":"important","confidence":2.5,"reason":"x"}'),
    ).toMatchObject({ confidence: 0 });
  });

  test("empty string", () => {
    expect(parseLLMOutput("")).toMatchObject({ label: "later", confidence: 0 });
  });

  test("garbage", () => {
    expect(parseLLMOutput("nope")).toMatchObject({ label: "later", confidence: 0 });
  });

  test("missing reason", () => {
    expect(
      parseLLMOutput('{"label":"news","confidence":0.7}'),
    ).toMatchObject({ label: "news", confidence: 0.7, reason: "no-reason" });
  });
});
