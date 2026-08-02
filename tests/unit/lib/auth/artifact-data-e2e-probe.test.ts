import {
  isArtifactDataE2EProbeEnabled,
  isLocalArtifactDataActionProbe,
} from "@/lib/auth/artifact-data-e2e-probe";

const enabledContext = {
  nodeEnv: "development",
  probeFlag: "true",
  hostname: "localhost",
};

const actionRequest = {
  ...enabledContext,
  method: "POST",
  pathname: "/test-user/artifact-data",
  hasNextActionHeader: true,
};

describe("artifact data E2E probe gate", () => {
  it("requires development mode, explicit opt-in, and a loopback hostname", () => {
    expect(isArtifactDataE2EProbeEnabled(enabledContext)).toBe(true);

    expect(
      isArtifactDataE2EProbeEnabled({
        ...enabledContext,
        nodeEnv: "production",
      }),
    ).toBe(false);
    expect(
      isArtifactDataE2EProbeEnabled({
        ...enabledContext,
        probeFlag: undefined,
      }),
    ).toBe(false);
    expect(
      isArtifactDataE2EProbeEnabled({
        ...enabledContext,
        hostname: "app.example.com",
      }),
    ).toBe(false);
  });

  it.each([
    ["method", { method: "GET" }],
    ["path", { pathname: "/test-user" }],
    ["Next-Action header", { hasNextActionHeader: false }],
  ])("requires the exact Server Action %s", (_label, override) => {
    expect(
      isLocalArtifactDataActionProbe({ ...actionRequest, ...override }),
    ).toBe(false);
  });

  it("allows only the exact opted-in local Server Action request", () => {
    expect(isLocalArtifactDataActionProbe(actionRequest)).toBe(true);
  });
});
