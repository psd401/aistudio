import {
  createOneRosterSettingsInputSchema,
  oneRosterSettingsInputSchema,
  ONEROSTER_SETTING_KEYS,
} from "@/lib/roster/settings";
import {
  isOneRosterSyncStatusActive,
  ONEROSTER_SYNC_ACTIVE_WINDOW_MS,
  parseOneRosterSyncStatus,
} from "@/lib/roster/status";

const validInput = {
  enabled: true,
  baseUrl: "https://district.example.org/",
  authMode: "oauth1" as const,
  credentialsSecretArn:
    "arn:aws:secretsmanager:us-west-2:123456789012:secret:aistudio-dev-oneroster-abc123",
  apiVersion: "v1p1" as const,
  pageSize: 10_000,
};

describe("OneRoster administrator settings", () => {
  it("accepts the two documented auth modes and normalizes HTTPS URLs", () => {
    const oauth1 = oneRosterSettingsInputSchema.parse(validInput);
    const proxy = oneRosterSettingsInputSchema.parse({
      ...validInput,
      authMode: "proxy",
      baseUrl:
        "https://oneroster-proxy.apis.classlink.com/proxy/v1p0/application-id?ignored=true",
    });

    expect(oauth1.baseUrl).toBe("https://district.example.org");
    expect(proxy.baseUrl).toBe(
      "https://oneroster-proxy.apis.classlink.com/proxy/v1p0/application-id"
    );
  });

  it("rejects unsafe URLs, generic token-flow fields, bad ARNs, and invalid page sizes", () => {
    expect(() =>
      oneRosterSettingsInputSchema.parse({
        ...validInput,
        baseUrl: "http://district.example.org",
      })
    ).toThrow();
    expect(() =>
      oneRosterSettingsInputSchema.parse({
        ...validInput,
        tokenUrl: "https://district.example.org/oauth/token",
      })
    ).toThrow();
    expect(() =>
      oneRosterSettingsInputSchema.parse({
        ...validInput,
        credentialsSecretArn:
          "arn:aws:secretsmanager:us-west-2:123456789012:secret:other-secret",
      })
    ).toThrow();
    expect(() =>
      oneRosterSettingsInputSchema.parse({ ...validInput, pageSize: 10_001 })
    ).toThrow();
  });

  it("rejects secret ARNs outside the current deployment", () => {
    const deploymentSchema = createOneRosterSettingsInputSchema({
      environment: "dev",
      region: "us-west-2",
      accountId: "123456789012",
    });

    expect(() =>
      deploymentSchema.parse({
        ...validInput,
        credentialsSecretArn:
          "arn:aws:secretsmanager:us-west-2:123456789012:secret:aistudio-prod-oneroster-abc123",
      })
    ).toThrow(/environment/);
    expect(() =>
      deploymentSchema.parse({
        ...validInput,
        credentialsSecretArn:
          "arn:aws:secretsmanager:us-east-1:123456789012:secret:aistudio-dev-oneroster-abc123",
      })
    ).toThrow(/region/);
    expect(() =>
      deploymentSchema.parse({
        ...validInput,
        credentialsSecretArn:
          "arn:aws:secretsmanager:us-west-2:210987654321:secret:aistudio-dev-oneroster-abc123",
      })
    ).toThrow(/account/);
    expect(deploymentSchema.parse(validInput)).toMatchObject({
      ...validInput,
      baseUrl: "https://district.example.org",
    });
  });

  it("includes the durable status key in the shared settings contract", () => {
    expect(ONEROSTER_SETTING_KEYS.syncStatus).toBe("ONEROSTER_SYNC_STATUS");
    expect(ONEROSTER_SETTING_KEYS.roleSyncEnabled).toBe(
      "ROSTER_ROLE_SYNC_ENABLED"
    );
  });
});

describe("OneRoster sync status parsing", () => {
  it("accepts the non-sensitive terminal run contract", () => {
    const status = parseOneRosterSyncStatus(
      JSON.stringify({
        runId: "run-1",
        trigger: "manual",
        state: "failed",
        startedAt: "2026-07-26T20:00:00.000Z",
        completedAt: "2026-07-26T20:01:00.000Z",
        unchanged: false,
        collections: [
          {
            name: "users",
            recordsTotal: 50,
            synced: 0,
            deactivated: 0,
            failed: 1,
          },
        ],
        error: "Users collection failed; last-known-good rows were preserved.",
      })
    );

    expect(status?.state).toBe("failed");
    expect(status?.collections[0]?.name).toBe("users");
  });

  it("fails closed for malformed or oversized status payloads", () => {
    expect(parseOneRosterSyncStatus("not-json")).toBeNull();
    expect(
      parseOneRosterSyncStatus(
        JSON.stringify({
          runId: "run-1",
          trigger: "manual",
          state: "succeeded",
          startedAt: "not-a-date",
          completedAt: null,
          unchanged: false,
          collections: [],
          error: null,
        })
      )
    ).toBeNull();
    expect(
      parseOneRosterSyncStatus(
        JSON.stringify({
          runId: "run-1",
          trigger: "manual",
          state: "failed",
          startedAt: "2026-07-26T20:00:00.000Z",
          completedAt: "2026-07-26T20:01:00.000Z",
          unchanged: false,
          collections: [],
          error: "x".repeat(501),
        })
      )
    ).toBeNull();
  });

  it("expires abandoned nonterminal runs after the retry window", () => {
    const now = Date.parse("2026-07-26T21:00:00.000Z");
    const activeStatus = parseOneRosterSyncStatus(
      JSON.stringify({
        runId: "run-active",
        trigger: "manual",
        state: "running",
        startedAt: new Date(
          now - ONEROSTER_SYNC_ACTIVE_WINDOW_MS + 1
        ).toISOString(),
        completedAt: null,
        unchanged: false,
        collections: [],
        error: null,
      })
    );
    const staleStatus = activeStatus
      ? {
          ...activeStatus,
          runId: "run-stale",
          startedAt: new Date(
            now - ONEROSTER_SYNC_ACTIVE_WINDOW_MS - 1
          ).toISOString(),
        }
      : null;

    expect(activeStatus).not.toBeNull();
    expect(activeStatus && isOneRosterSyncStatusActive(activeStatus, now)).toBe(
      true
    );
    expect(staleStatus && isOneRosterSyncStatusActive(staleStatus, now)).toBe(
      false
    );
  });
});
