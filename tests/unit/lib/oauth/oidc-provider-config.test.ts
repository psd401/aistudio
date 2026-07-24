import type { JWK } from "jose"

jest.mock("oidc-provider", () => ({
  __esModule: true,
  default: class MockProvider {},
}))

import { createOidcProviderCacheFingerprint } from "@/lib/oauth/oidc-provider-config"

const oldPublicKey: JWK = {
  kid: "old",
  kty: "RSA",
  alg: "RS256",
  use: "sig",
  n: "old-modulus",
  e: "AQAB",
}

const newPublicKey: JWK = {
  kid: "new",
  kty: "RSA",
  alg: "RS256",
  use: "sig",
  n: "new-modulus",
  e: "AQAB",
}

describe("OIDC provider cache fingerprint", () => {
  it("changes when a staged standby key becomes active", () => {
    const publicKeys = [oldPublicKey, newPublicKey]

    const beforeActivation = createOidcProviderCacheFingerprint(
      "https://aistudio.example",
      {
        activeKid: "old",
        publicKeys,
      }
    )
    const afterActivation = createOidcProviderCacheFingerprint(
      "https://aistudio.example",
      {
        activeKid: "new",
        publicKeys,
      }
    )

    expect(afterActivation).not.toBe(beforeActivation)
  })

  it("changes when the issuer changes with the same signing keys", () => {
    const keys = {
      activeKid: "old",
      publicKeys: [oldPublicKey],
    }

    expect(
      createOidcProviderCacheFingerprint("https://dev.example", keys)
    ).not.toBe(
      createOidcProviderCacheFingerprint("https://prod.example", keys)
    )
  })

  it("changes when public key material changes under the same kid", () => {
    const before = createOidcProviderCacheFingerprint(
      "https://aistudio.example",
      {
        activeKid: "old",
        publicKeys: [oldPublicKey],
      }
    )
    const after = createOidcProviderCacheFingerprint(
      "https://aistudio.example",
      {
        activeKid: "old",
        publicKeys: [{ ...oldPublicKey, n: "replacement-modulus" }],
      }
    )

    expect(after).not.toBe(before)
  })
})
