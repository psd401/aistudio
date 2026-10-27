/**
 * Unit tests for keyless Google Directory auth (#1989).
 *
 * Locks down: the client federates to the directory-reader provider,
 * impersonates the shared groups reader with ONLY the read-only Cloud Identity
 * groups scope, signs its AWS proof with the Lambda runtime's credentials, and
 * fails closed when its config is missing. Offline: retrieveSubjectToken only
 * signs a GetCallerIdentity request.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CLOUD_IDENTITY_GROUPS_READONLY_SCOPE,
  createDirectoryAuth,
} from "./directory-auth";

const AUDIENCE =
  "//iam.googleapis.com/projects/1022506104054/locations/global/" +
  "workloadIdentityPools/aws-agent-broker/providers/directory-reader";
const READER = "directory-groups-reader@psd-org-tooling.iam.gserviceaccount.com";

const ENV = {
  GOOGLE_DIRECTORY_WIF_AUDIENCE: AUDIENCE,
  GOOGLE_DIRECTORY_SERVICE_ACCOUNT_EMAIL: READER,
};

// google-auth-library's AWS source reads the Lambda runtime's credentials from
// process.env at signing time.
const AWS_ENV = {
  AWS_REGION: "us-east-1",
  AWS_ACCESS_KEY_ID: "AKIDEXAMPLEGROUPSYNC",
  AWS_SECRET_ACCESS_KEY: "fake-secret-for-signing-only",
  AWS_SESSION_TOKEN: "fake-lambda-session-token",
};
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const [k, v] of Object.entries(AWS_ENV)) {
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

interface SubjectToken {
  url: string;
  headers: Array<{ key: string; value: string }>;
}

describe("createDirectoryAuth", () => {
  test("impersonates the shared reader with only the read-only groups scope", () => {
    const client = createDirectoryAuth(ENV);
    expect(client.getServiceAccountEmail()).toBe(READER);
    expect(client.scopes).toEqual([CLOUD_IDENTITY_GROUPS_READONLY_SCOPE]);
  });

  test("signs the AWS proof for the directory-reader audience with runtime credentials", async () => {
    const client = createDirectoryAuth(ENV);
    const token = JSON.parse(
      decodeURIComponent(await client.retrieveSubjectToken())
    ) as SubjectToken;
    const header = (key: string) =>
      token.headers.find((h) => h.key.toLowerCase() === key)?.value;

    expect(token.url).toBe(
      "https://sts.us-east-1.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15"
    );
    expect(header("x-goog-cloud-target-resource")).toBe(AUDIENCE);
    expect(header("x-amz-security-token")).toBe("fake-lambda-session-token");
    expect(header("authorization")).toContain("Credential=AKIDEXAMPLEGROUPSYNC/");
  });

  test.each(["GOOGLE_DIRECTORY_WIF_AUDIENCE", "GOOGLE_DIRECTORY_SERVICE_ACCOUNT_EMAIL"])(
    "fails closed when %s is missing",
    (name) => {
      const env: Record<string, string> = { ...ENV };
      delete env[name];
      expect(() => createDirectoryAuth(env)).toThrow(`${name} is not configured`);
    }
  );
});
