/**
 * @jest-environment node
 *
 * Google provider client construction (REV-COR-505 / REV-REF-034): both the model
 * factory and the native-tools builder must construct a per-call
 * `createGoogleGenerativeAI({ apiKey })` client and must NOT mutate
 * `process.env.GOOGLE_GENERATIVE_AI_API_KEY`.
 *
 * Uses the global `jest` (not @jest/globals) so jest.mock hoisting works.
 */
import * as fs from "fs";
import * as path from "path";

const googleSearchTool = { __googleSearch: true };
const createGoogleGenerativeAIMock = jest.fn((_opts: unknown) =>
  Object.assign((modelId: string) => ({ modelId, provider: "google" }), {
    tools: { googleSearch: jest.fn(() => googleSearchTool) },
  })
);

jest.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: (opts: unknown) => createGoogleGenerativeAIMock(opts),
}));

jest.mock("@/lib/settings-manager", () => ({
  Settings: {
    getGoogleAI: jest.fn().mockResolvedValue("test-google-key"),
    getOpenAI: jest.fn(),
    getBedrock: jest.fn(),
    getAzure: jest.fn(),
  },
}));

import { createProviderModel } from "@/lib/ai/provider-factory";
import { createProviderNativeTools } from "@/lib/tools/provider-native-tools";

const ENV_KEY = "GOOGLE_GENERATIVE_AI_API_KEY";

describe("Google client construction (REV-COR-505 / REV-REF-034)", () => {
  beforeEach(() => {
    createGoogleGenerativeAIMock.mockClear();
    delete process.env[ENV_KEY];
  });

  it("createProviderModel('google') builds a scoped client and does not touch process.env", async () => {
    const model = await createProviderModel("google", "gemini-2.5-flash");
    expect(createGoogleGenerativeAIMock).toHaveBeenCalledWith({ apiKey: "test-google-key" });
    expect(model).toBeDefined();
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it("createProviderNativeTools('google') builds google_search without touching process.env", async () => {
    const tools = await createProviderNativeTools("google", "gemini-2.5-flash", ["webSearch"]);
    expect(createGoogleGenerativeAIMock).toHaveBeenCalledWith({ apiKey: "test-google-key" });
    expect((tools as Record<string, unknown>).google_search).toBeDefined();
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it("neither source module assigns process.env.GOOGLE_GENERATIVE_AI_API_KEY (REF-034)", () => {
    const root = path.join(__dirname, "..", "..", "..", "..");
    const assignRe = /process\.env\.GOOGLE_GENERATIVE_AI_API_KEY\s*=/;
    for (const rel of ["lib/ai/provider-factory.ts", "lib/tools/provider-native-tools.ts"]) {
      const src = fs.readFileSync(path.join(root, rel), "utf8");
      expect(assignRe.test(src)).toBe(false);
    }
  });
});
