/**
 * @jest-environment node
 *
 * lib/ai/google-provider.ts: keyless Vertex AI whenever the GOOGLE_VERTEX_*
 * variables are set (deployed); the GOOGLE_API_KEY settings row only when
 * they are all unset (local dev); fail closed when they are partly set.
 */

const mockGetGoogleAI = jest.fn();
jest.mock("@/lib/settings-manager", () => ({
  Settings: { getGoogleAI: (...args: unknown[]) => mockGetGoogleAI(...args) },
}));

import {
  VERTEX_GEMINI_LOCATION,
  VERTEX_LIVE_LOCATION,
  getGoogleGenAIOptions,
  isGoogleConfigured,
} from "@/lib/ai/google-provider";
import { __resetVertexWifCacheForTests } from "@/lib/ai/google-vertex-wif";

const VERTEX_ENV = {
  GOOGLE_VERTEX_WIF_AUDIENCE:
    "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/vertex-ai",
  GOOGLE_VERTEX_SERVICE_ACCOUNT_EMAIL: "aistudio-vertex@psd-aistudio-dev.iam.gserviceaccount.com",
  GOOGLE_VERTEX_PROJECT_ID: "psd-aistudio-dev",
  AWS_REGION: "us-east-1",
};
const saved: Record<string, string | undefined> = {};

function setEnv(values: Partial<typeof VERTEX_ENV>) {
  for (const k of Object.keys(VERTEX_ENV)) {
    if (!(k in saved)) saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  __resetVertexWifCacheForTests();
  mockGetGoogleAI.mockReset();
});

describe("location constants", () => {
  it("serves chat/image from global and Live from the us multi-region", () => {
    expect(VERTEX_GEMINI_LOCATION).toBe("global");
    expect(VERTEX_LIVE_LOCATION).toBe("us");
  });
});

describe("getGoogleGenAIOptions", () => {
  it("returns keyless Vertex options without reading the API key", async () => {
    setEnv(VERTEX_ENV);
    const options = await getGoogleGenAIOptions("us");
    expect(options).toEqual({
      vertexai: true,
      project: "psd-aistudio-dev",
      location: "us",
      googleAuthOptions: { authClient: expect.anything() },
    });
    expect(options.apiKey).toBeUndefined();
    expect(mockGetGoogleAI).not.toHaveBeenCalled();
  });

  it("falls back to the API key only when every GOOGLE_VERTEX_* variable is unset", async () => {
    setEnv({});
    mockGetGoogleAI.mockResolvedValue("local-dev-key");
    await expect(getGoogleGenAIOptions("us")).resolves.toEqual({ apiKey: "local-dev-key" });
  });

  it("throws a configuration error when neither Vertex nor a key is configured", async () => {
    setEnv({});
    mockGetGoogleAI.mockResolvedValue(null);
    await expect(getGoogleGenAIOptions("us")).rejects.toThrow("Google API key not configured");
  });

  it("fails closed when Vertex is only partly configured", async () => {
    setEnv({ GOOGLE_VERTEX_PROJECT_ID: "psd-aistudio-dev", AWS_REGION: "us-east-1" });
    mockGetGoogleAI.mockResolvedValue("local-dev-key");
    await expect(getGoogleGenAIOptions("us")).rejects.toThrow("Vertex AI auth is partly configured");
  });
});

describe("isGoogleConfigured", () => {
  it("is true with Vertex WIF and no API key", async () => {
    setEnv(VERTEX_ENV);
    mockGetGoogleAI.mockResolvedValue(null);
    await expect(isGoogleConfigured()).resolves.toBe(true);
  });

  it("follows the API key when Vertex is unset", async () => {
    setEnv({});
    mockGetGoogleAI.mockResolvedValue("  ");
    await expect(isGoogleConfigured()).resolves.toBe(false);
    mockGetGoogleAI.mockResolvedValue("local-dev-key");
    await expect(isGoogleConfigured()).resolves.toBe(true);
  });
});
