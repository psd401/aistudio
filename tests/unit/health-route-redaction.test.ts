/** @jest-environment node */

const secretArn =
  "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/oauth-key";

jest.mock("@/lib/db/drizzle-client", () => ({
  validateDatabaseConnection: jest.fn(async () => ({
    success: false,
    message: "Database connection validation failed",
    config: {
      hasDatabaseUrl: true,
      hasDbHost: false,
      maxConnections: "20",
      database: "secret_database_name",
    },
    error: `AccessDeniedException for ${secretArn}`,
  })),
}));
jest.mock("@/lib/auth/server-session", () => ({
  getServerSession: jest.fn(async () => ({
    sub: "user-1",
    email: "private-user@example.test",
  })),
}));
jest.mock("@/lib/oauth/oidc-signing-key-store", () => ({
  getOidcSigningKeySet: jest.fn(async () => {
    throw new Error(`Access denied to ${secretArn}`);
  }),
}));
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  generateRequestId: () => "health-request",
  startTimer: () => jest.fn(),
}));

import { GET } from "@/app/api/health/route";

describe("GET /api/health redaction", () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousAuthSecret = process.env.AUTH_SECRET;
  const previousCognitoClient = process.env.AUTH_COGNITO_CLIENT_ID;

  beforeAll(() => {
    process.env.DATABASE_URL = "postgresql://redacted";
    process.env.AUTH_SECRET = "configured";
    process.env.AUTH_COGNITO_CLIENT_ID = "configured";
  });

  afterAll(() => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousAuthSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previousAuthSecret;
    if (previousCognitoClient === undefined) {
      delete process.env.AUTH_COGNITO_CLIENT_ID;
    } else {
      process.env.AUTH_COGNITO_CLIENT_ID = previousCognitoClient;
    }
  });

  it("returns only readiness states and never internal error/configuration data", async () => {
    const response = await GET();
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(503);
    expect(body).toEqual(
      expect.objectContaining({
        status: "unhealthy",
        checks: {
          environment: { status: expect.any(String) },
          authentication: { status: "healthy" },
          database: { status: "unhealthy" },
          oauthSigning: { status: "unhealthy" },
        },
      })
    );
    expect(serialized).not.toContain(secretArn);
    expect(serialized).not.toContain("secret_database_name");
    expect(serialized).not.toContain("private-user@example.test");
    expect(serialized).not.toContain("AccessDenied");
  });
});
