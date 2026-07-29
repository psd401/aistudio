import { describe, expect, it } from "@jest/globals"
import {
  buildOAuthCredentials,
  type ConnectorFormValues,
  validateConnectorForm,
} from "@/app/(protected)/admin/connectors/_components/connector-form-state"

const baseForm: ConnectorFormValues = {
  authType: "oauth",
  clearOAuthCredentials: false,
  credentialsKey: "",
  maxConnections: "10",
  name: "Canva",
  oauthAuthEndpoint: "",
  oauthClientId: " client-id ",
  oauthClientSecret: "",
  oauthScopes: "",
  oauthTokenEndpoint: "",
  toolSource: "mcp",
  transport: "http",
  url: "https://mcp.example.test",
}

describe("connector form OAuth credentials", () => {
  it("requires a secret when registering credentials on create", () => {
    expect(validateConnectorForm(baseForm, false)).toEqual({
      valid: false,
      error: "Client Secret is required when setting OAuth credentials.",
    })
  })

  it("keeps existing credentials when editing without a new secret", () => {
    expect(buildOAuthCredentials(baseForm, true)).toBeUndefined()
  })

  it("explicitly clears stored credentials", () => {
    expect(
      buildOAuthCredentials(
        { ...baseForm, clearOAuthCredentials: true },
        true
      )
    ).toBeNull()
  })

  it("normalizes a complete replacement credential payload", () => {
    expect(
      buildOAuthCredentials(
        {
          ...baseForm,
          oauthAuthEndpoint: " https://provider.test/authorize ",
          oauthClientSecret: "secret",
          oauthScopes: " read write ",
        },
        true
      )
    ).toEqual({
      authorizationEndpointUrl: "https://provider.test/authorize",
      clientId: "client-id",
      clientSecret: "secret",
      scopes: "read write",
      tokenEndpointUrl: undefined,
    })
  })
})
