import {
  DEFAULT_REPOSITORY_EMBEDDING_DIMENSIONS,
  canReuseRepositoryEmbeddings,
  parseRepositoryEmbeddingDescriptor,
  repositoryEmbeddingConfigurationFromSettings,
} from "@/lib/repositories/embedding-configuration"

describe("repository embedding configuration", () => {
  test("defaults to IAM-authenticated Bedrock without secrets", () => {
    expect(repositoryEmbeddingConfigurationFromSettings({})).toEqual({
      provider: "amazon-bedrock",
      modelId: "amazon.titan-embed-text-v1",
      dimensions: DEFAULT_REPOSITORY_EMBEDDING_DIMENSIONS,
      descriptor: "amazon-bedrock:amazon.titan-embed-text-v1",
    })
  })

  test("preserves model colons when parsing a generation descriptor", () => {
    expect(parseRepositoryEmbeddingDescriptor("amazon-bedrock:amazon.titan-embed-text-v2:0", 1024)).toMatchObject({
      provider: "amazon-bedrock",
      modelId: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
    })
  })

  test("normalizes the Azure provider alias used by existing settings", () => {
    expect(
      repositoryEmbeddingConfigurationFromSettings({
        EMBEDDING_MODEL_PROVIDER: "azure-openai",
        EMBEDDING_MODEL_ID: "district-embedding-deployment",
        EMBEDDING_DIMENSIONS: "1536",
      }),
    ).toMatchObject({
      provider: "azure",
      descriptor: "azure:district-embedding-deployment",
    })
  })

  test("only reuses vectors from the same model and dimensions", () => {
    expect(
      canReuseRepositoryEmbeddings("openai:text-embedding-3-small", 1536, "openai:text-embedding-3-small", 1536),
    ).toBe(true)
    expect(
      canReuseRepositoryEmbeddings(
        "openai:text-embedding-3-small",
        1536,
        "amazon-bedrock:amazon.titan-embed-text-v1",
        1536,
      ),
    ).toBe(false)
  })

  test("rejects dimensions that do not match the repository vector schema", () => {
    expect(() =>
      repositoryEmbeddingConfigurationFromSettings({
        EMBEDDING_MODEL_PROVIDER: "amazon-bedrock",
        EMBEDDING_MODEL_ID: "amazon.titan-embed-text-v2:0",
        EMBEDDING_DIMENSIONS: "1024",
      }),
    ).toThrow("must use 1536 dimensions")
  })
})
