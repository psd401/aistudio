import {
  encryptToken,
  decryptToken,
  invalidateDEKCache,
  _resetForTesting,
} from "@/lib/crypto/token-encryption"
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager"

// Mock AWS SDK
jest.mock("@aws-sdk/client-secrets-manager")

// Mock logger
jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}))

// Test secret — any string works since the module derives a 32-byte key via SHA-256
const TEST_SECRET = "my-super-secret-encryption-key-from-secrets-manager"

describe("Token Encryption (AES-256-GCM)", () => {
  let mockSend: jest.Mock

  beforeEach(() => {
    _resetForTesting()
    jest.clearAllMocks()

    mockSend = jest.fn().mockResolvedValue({
      SecretString: TEST_SECRET,
    })

    ;(SecretsManagerClient as jest.Mock).mockImplementation(() => ({
      send: mockSend,
    }))
  })

  describe("encryptToken / decryptToken", () => {
    it("should round-trip encrypt and decrypt a token", async () => {
      const token = "ghp_abc123XYZ_oauth_token_value"

      const encrypted = await encryptToken(token)
      const decrypted = await decryptToken(encrypted)

      expect(decrypted).toBe(token)
    })

    it("should produce different ciphertext for the same plaintext (unique IVs)", async () => {
      const token = "same-token-value"

      const encrypted1 = await encryptToken(token)
      const encrypted2 = await encryptToken(token)

      expect(encrypted1).not.toBe(encrypted2)

      // Both should decrypt to the same value
      expect(await decryptToken(encrypted1)).toBe(token)
      expect(await decryptToken(encrypted2)).toBe(token)
    })

    it("should handle empty string tokens", async () => {
      const encrypted = await encryptToken("")
      const decrypted = await decryptToken(encrypted)
      expect(decrypted).toBe("")
    })

    it("should handle unicode tokens", async () => {
      const token = "tökën_with_ünïcödë_🔑"
      const encrypted = await encryptToken(token)
      const decrypted = await decryptToken(encrypted)
      expect(decrypted).toBe(token)
    })

    it("should handle long tokens", async () => {
      const token = "a".repeat(10000)
      const encrypted = await encryptToken(token)
      const decrypted = await decryptToken(encrypted)
      expect(decrypted).toBe(token)
    })
  })

  describe("encrypted payload format", () => {
    it("should produce a base64-encoded JSON string with iv, tag, data", async () => {
      const encrypted = await encryptToken("test")

      // Decode the base64 outer wrapper
      const json = Buffer.from(encrypted, "base64").toString("utf8")
      const payload = JSON.parse(json)

      expect(payload).toHaveProperty("iv")
      expect(payload).toHaveProperty("tag")
      expect(payload).toHaveProperty("data")
      expect(typeof payload.iv).toBe("string")
      expect(typeof payload.tag).toBe("string")
      expect(typeof payload.data).toBe("string")

      // IV should be 12 bytes
      const ivBytes = Buffer.from(payload.iv, "base64")
      expect(ivBytes.length).toBe(12)

      // Auth tag should be 16 bytes
      const tagBytes = Buffer.from(payload.tag, "base64")
      expect(tagBytes.length).toBe(16)
    })
  })

  describe("decryption error handling", () => {
    it("should throw on invalid base64 input", async () => {
      await expect(decryptToken("not-valid-base64!!!")).rejects.toThrow(
        "Invalid encrypted token format"
      )
    })

    it("should throw on missing payload fields", async () => {
      const incomplete = Buffer.from(JSON.stringify({ iv: "abc" })).toString(
        "base64"
      )
      await expect(decryptToken(incomplete)).rejects.toThrow(
        "missing iv, tag, or data"
      )
    })

    it("should throw on tampered ciphertext (auth tag verification)", async () => {
      const encrypted = await encryptToken("secret-token")

      // Tamper with the payload
      const json = Buffer.from(encrypted, "base64").toString("utf8")
      const payload = JSON.parse(json)
      // Flip a byte in the data
      const dataBytes = Buffer.from(payload.data, "base64")
      dataBytes[0] = dataBytes[0] ^ 0xff
      payload.data = dataBytes.toString("base64")
      const tampered = Buffer.from(JSON.stringify(payload)).toString("base64")

      await expect(decryptToken(tampered)).rejects.toThrow()
    })
  })

  describe("DEK caching", () => {
    it("should cache the DEK and not re-fetch within TTL", async () => {
      await encryptToken("first")
      await encryptToken("second")
      await encryptToken("third")

      // SecretsManagerClient constructor called once, send called once
      expect(mockSend).toHaveBeenCalledTimes(1)
    })

    it("should re-fetch DEK after cache invalidation", async () => {
      await encryptToken("first")
      expect(mockSend).toHaveBeenCalledTimes(1)

      invalidateDEKCache()

      await encryptToken("second")
      expect(mockSend).toHaveBeenCalledTimes(2)
    })
  })

  describe("DEK retrieval", () => {
    it("should throw when secret is empty", async () => {
      mockSend.mockResolvedValueOnce({ SecretString: undefined })

      await expect(encryptToken("test")).rejects.toThrow("is empty")
    })

    it("should work with any secret string format (derived via SHA-256)", async () => {
      // Short secret
      mockSend.mockResolvedValueOnce({ SecretString: "short" })
      _resetForTesting()
      const encrypted1 = await encryptToken("test")

      // Same secret should produce same key → decryptable
      mockSend.mockResolvedValueOnce({ SecretString: "short" })
      _resetForTesting()
      const decrypted1 = await decryptToken(encrypted1)
      expect(decrypted1).toBe("test")
    })

    it("should fail to decrypt when secret changes (different derived key)", async () => {
      // Encrypt with one secret
      mockSend.mockResolvedValueOnce({ SecretString: "key-version-1" })
      _resetForTesting()
      const encrypted = await encryptToken("my-token")

      // Try to decrypt with a different secret
      mockSend.mockResolvedValueOnce({ SecretString: "key-version-2" })
      _resetForTesting()
      await expect(decryptToken(encrypted)).rejects.toThrow()
    })
  })
})
