import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto"
import {
  parseOidcSigningKeySet,
  type StoredOidcSigningKey,
  type StoredOidcSigningKeySet,
} from "@/lib/oauth/oidc-signing-key-store"

function privateKey(
  kid: string,
  status: "active" | "standby" | "retiring",
  timing?: string
): StoredOidcSigningKey {
  const { privateKey: key } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  })
  return {
    status,
    createdAt: "2026-07-24T00:00:00.000Z",
    activateAfter: status === "standby" ? timing : undefined,
    retireAfter: status === "retiring" ? timing : undefined,
    jwk: {
      ...key.export({ format: "jwk" }),
      kid,
      alg: "RS256",
      use: "sig",
    },
  }
}

describe("OIDC signing key store (#1285)", () => {
  const now = new Date("2026-07-24T12:00:00.000Z")

  it("puts the active key first and publishes retiring overlap keys", () => {
    const oldKey = privateKey(
      "old",
      "retiring",
      "2026-07-24T14:00:00.000Z"
    )
    const active = privateKey("active", "active")
    const stored: StoredOidcSigningKeySet = {
      version: 1,
      activeKid: "active",
      keys: [oldKey, active],
    }

    const parsed = parseOidcSigningKeySet(stored, now)

    expect(parsed.signingKeys.map((key) => key.kid)).toEqual([
      "active",
      "old",
    ])
    expect(parsed.publicKeys.map((key) => key.kid)).toEqual([
      "active",
      "old",
    ])
    expect(parsed.publicKeys).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ d: expect.anything() }),
      ])
    )

    const payload = Buffer.from("key-overlap-verification")
    for (const [index, key] of [active, oldKey].entries()) {
      const signature = sign(
        "RSA-SHA256",
        payload,
        createPrivateKey({ key: key.jwk, format: "jwk" })
      )
      expect(
        verify(
          "RSA-SHA256",
          payload,
          createPublicKey({
            key: parsed.publicKeys[index],
            format: "jwk",
          }),
          signature
        )
      ).toBe(true)
    }
  })

  it("drops retiring keys after their overlap deadline", () => {
    const parsed = parseOidcSigningKeySet(
      {
        version: 1,
        activeKid: "active",
        keys: [
          privateKey("active", "active"),
          privateKey(
            "expired",
            "retiring",
            "2026-07-24T11:59:59.000Z"
          ),
        ],
      },
      now
    )

    expect(parsed.publicKeys.map((key) => key.kid)).toEqual(["active"])
  })

  it("prepublishes a standby key before switching all tasks at activateAfter", () => {
    const stored: StoredOidcSigningKeySet = {
      version: 1,
      activeKid: "old-active",
      keys: [
        privateKey("old-active", "active"),
        privateKey(
          "new-standby",
          "standby",
          "2026-07-24T12:06:00.000Z"
        ),
      ],
    }

    const before = parseOidcSigningKeySet(
      stored,
      new Date("2026-07-24T12:05:59.000Z")
    )
    const after = parseOidcSigningKeySet(
      stored,
      new Date("2026-07-24T12:06:01.000Z")
    )

    expect(before.activeKid).toBe("old-active")
    expect(before.publicKeys.map((key) => key.kid)).toEqual([
      "old-active",
      "new-standby",
    ])
    expect(after.activeKid).toBe("new-standby")
    expect(after.publicKeys.map((key) => key.kid)).toEqual([
      "new-standby",
      "old-active",
    ])
  })

  it.each([
    {
      name: "multiple active keys",
      mutate: (key: StoredOidcSigningKey) => ({
        version: 1,
        activeKid: String(key.jwk.kid),
        keys: [key, { ...key }],
      }),
    },
    {
      name: "public-only active key",
      mutate: (key: StoredOidcSigningKey) => {
        const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...jwk } =
          key.jwk
        return {
          version: 1,
          activeKid: String(key.jwk.kid),
          keys: [{ ...key, jwk }],
        }
      },
    },
    {
      name: "mismatched activeKid",
      mutate: (key: StoredOidcSigningKey) => ({
        version: 1,
        activeKid: "different",
        keys: [key],
      }),
    },
  ])("rejects $name", ({ mutate }) => {
    expect(() =>
      parseOidcSigningKeySet(mutate(privateKey("active", "active")), now)
    ).toThrow()
  })
})
