/**
 * @jest-environment node
 *
 * Google provider client construction (REV-COR-505 / REV-REF-034): both the model
 * factory and the native-tools builder must construct a per-call client and
 * must NOT mutate `process.env.GOOGLE_GENERATIVE_AI_API_KEY`. With the
 * GOOGLE_VERTEX_* variables set (deployed) that client is keyless Vertex AI;
 * without them (local dev) it is `createGoogleGenerativeAI({ apiKey })`.
 *
 * Uses the global `jest` (not @jest/globals) so jest.mock hoisting works.
 */

import * as path from "node:path";

const googleSearchTool = { __googleSearch: true };
const createGoogleGenerativeAIMock = jest.fn((_opts: unknown) =>
  Object.assign((modelId: string) => ({ modelId, provider: "google" }), {
    tools: { googleSearch: jest.fn(() => googleSearchTool) },
  })
);

jest.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: (opts: unknown) => createGoogleGenerativeAIMock(opts),
}));

const createVertexMock = jest.fn((_opts: unknown) =>
  Object.assign((modelId: string) => ({ modelId, provider: "google.vertex" }), {
    tools: { googleSearch: jest.fn(() => googleSearchTool) },
  })
);

jest.mock("@ai-sdk/google-vertex", () => ({
  createVertex: (opts: unknown) => createVertexMock(opts),
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
import { validatedFs } from "@/lib/filesystem/validated-fs";

const ENV_KEY = "GOOGLE_GENERATIVE_AI_API_KEY";
const VERTEX_ENV = {
  GOOGLE_VERTEX_WIF_AUDIENCE:
    "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/vertex-ai",
  GOOGLE_VERTEX_SERVICE_ACCOUNT_EMAIL: "aistudio-vertex@psd-aistudio-dev.iam.gserviceaccount.com",
  GOOGLE_VERTEX_PROJECT_ID: "psd-aistudio-dev",
  AWS_REGION: "us-east-1",
};

describe("Google client construction (REV-COR-505 / REV-REF-034)", () => {
  beforeEach(() => {
    createGoogleGenerativeAIMock.mockClear();
    createVertexMock.mockClear();
    delete process.env[ENV_KEY];
  });

  it("createProviderModel('google') builds a scoped client and does not touch process.env", async () => {
    const model = await createProviderModel("google", "gemini-3.8-flash");
    expect(createGoogleGenerativeAIMock).toHaveBeenCalledWith({ apiKey: "test-google-key" });
    expect(model).toBeDefined();
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it("createProviderNativeTools('google') builds google_search without touching process.env", async () => {
    const tools = await createProviderNativeTools("google", "gemini-3.8-flash", ["webSearch"]);
    expect(createGoogleGenerativeAIMock).toHaveBeenCalledWith({ apiKey: "test-google-key" });
    expect((tools as Record<string, unknown>).google_search).toBeDefined();
    expect(process.env[ENV_KEY]).toBeUndefined();
  });

  it("neither source module assigns process.env.GOOGLE_GENERATIVE_AI_API_KEY (REF-034)", () => {
    const root = path.join(__dirname, "..", "..", "..", "..");
    const assignRe = /process\.env\.GOOGLE_GENERATIVE_AI_API_KEY\s*=/;
    for (const rel of [
      "lib/ai/provider-factory.ts",
      "lib/tools/provider-native-tools.ts",
      "lib/ai/google-provider.ts",
    ]) {
      const src = validatedFs.readFileSync(path.join(root, rel), "utf8");
      expect(assignRe.test(src)).toBe(false);
    }
  });
});

describe("Google client construction with Vertex AI WIF configured", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    createGoogleGenerativeAIMock.mockClear();
    createVertexMock.mockClear();
    for (const [k, v] of Object.entries(VERTEX_ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("createProviderModel('google') uses keyless Vertex on the global endpoint", async () => {
    const model = await createProviderModel("google", "gemini-3.8-flash");
    expect(createVertexMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "psd-aistudio-dev",
        location: "global",
        googleAuthOptions: { authClient: expect.anything() },
      })
    );
    expect(createGoogleGenerativeAIMock).not.toHaveBeenCalled();
    expect(model).toEqual({ modelId: "gemini-3.8-flash", provider: "google.vertex" });
  });

  it("createProviderNativeTools('google') builds google_search from the Vertex client", async () => {
    const tools = await createProviderNativeTools("google", "gemini-3.8-flash", ["webSearch"]);
    expect(createVertexMock).toHaveBeenCalled();
    expect(createGoogleGenerativeAIMock).not.toHaveBeenCalled();
    expect((tools as Record<string, unknown>).google_search).toBe(googleSearchTool);
  });
});
