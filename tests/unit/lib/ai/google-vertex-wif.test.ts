/** @jest-environment node */

const awsClientCtor = jest.fn()
const awsCredentialsMock = jest.fn()

jest.mock("google-auth-library", () => ({
  AwsClient: class {
    constructor(options: unknown) {
      awsClientCtor(options)
    }
  },
}))

jest.mock("@aws-sdk/credential-providers", () => ({
  fromNodeProviderChain: () => awsCredentialsMock,
}))

import {
  VERTEX_CLOUD_PLATFORM_SCOPE,
  __resetVertexWifCacheForTests,
  getVertexWifAuthClient,
  readVertexWifConfig,
} from "@/lib/ai/google-vertex-wif"

const FULL_ENV = {
  GOOGLE_VERTEX_WIF_AUDIENCE: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/vertex-ai",
  GOOGLE_VERTEX_SERVICE_ACCOUNT_EMAIL: "aistudio-vertex@psd-aistudio-dev.iam.gserviceaccount.com",
  GOOGLE_VERTEX_PROJECT_ID: "psd-aistudio-dev",
  AWS_REGION: "us-east-1",
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetVertexWifCacheForTests()
})

describe("readVertexWifConfig", () => {
  it("returns null when no Vertex variable is set (local development)", () => {
    expect(readVertexWifConfig({ AWS_REGION: "us-east-1" })).toBeNull()
  })

  it("throws when only some variables are set, naming the missing ones", () => {
    expect(() =>
      readVertexWifConfig({ GOOGLE_VERTEX_PROJECT_ID: "psd-aistudio-dev", AWS_REGION: "us-east-1" })
    ).toThrow("GOOGLE_VERTEX_WIF_AUDIENCE, GOOGLE_VERTEX_SERVICE_ACCOUNT_EMAIL")
  })

  it("throws without an AWS region", () => {
    const { AWS_REGION: _omit, ...env } = FULL_ENV
    expect(() => readVertexWifConfig(env)).toThrow("AWS_REGION")
  })

  it("reads a full config, falling back to AWS_DEFAULT_REGION", () => {
    const { AWS_REGION: _omit, ...env } = FULL_ENV
    expect(readVertexWifConfig({ ...env, AWS_DEFAULT_REGION: "us-west-2" })).toEqual({
      audience: FULL_ENV.GOOGLE_VERTEX_WIF_AUDIENCE,
      serviceAccountEmail: FULL_ENV.GOOGLE_VERTEX_SERVICE_ACCOUNT_EMAIL,
      projectId: "psd-aistudio-dev",
      region: "us-west-2",
    })
  })
})

describe("getVertexWifAuthClient", () => {
  it("builds one AwsClient that impersonates the env's account with cloud-platform scope", async () => {
    const config = readVertexWifConfig(FULL_ENV)!
    const first = getVertexWifAuthClient(config)
    const second = getVertexWifAuthClient(config)

    expect(first).toBe(second)
    expect(awsClientCtor).toHaveBeenCalledTimes(1)
    const options = awsClientCtor.mock.calls[0][0]
    expect(options).toMatchObject({
      audience: FULL_ENV.GOOGLE_VERTEX_WIF_AUDIENCE,
      subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
      service_account_impersonation_url:
        "https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/" +
        "aistudio-vertex@psd-aistudio-dev.iam.gserviceaccount.com:generateAccessToken",
      scopes: [VERTEX_CLOUD_PLATFORM_SCOPE],
    })

    awsCredentialsMock.mockResolvedValueOnce({
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "secret-test",
      sessionToken: "session-test",
    })
    const supplier = options.aws_security_credentials_supplier
    await expect(supplier.getAwsRegion()).resolves.toBe("us-east-1")
    await expect(supplier.getAwsSecurityCredentials()).resolves.toEqual({
      accessKeyId: "AKIA_TEST",
      secretAccessKey: "secret-test",
      token: "session-test",
    })
  })
})
