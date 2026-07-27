"use client"

import { useState } from "react"
import {
  createMcpServer,
  type McpServerWithStats,
  updateMcpServer,
} from "@/actions/admin/connector.actions"
import type { McpToolSource } from "@/lib/mcp/connector-types"
import {
  AuthSpecificFields,
  BasicConnectorFields,
  ConnectorSubmitFields,
  OAuthConnectorFields,
} from "./connector-form-fields"
import {
  buildOAuthCredentials,
  type ConnectorFormValues,
  initialConnectorForm,
  validateConnectorForm,
} from "./connector-form-state"

interface Props {
  server: McpServerWithStats | null
  onSuccess: () => void
}

export function ConnectorFormSheet({ server, onSuccess }: Props) {
  const isEditing = server !== null
  const [form, setForm] = useState<ConnectorFormValues>(() =>
    initialConnectorForm(server)
  )
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hasExistingOAuthCredentials = Boolean(
    isEditing && server.hasOAuthCredentials
  )

  function updateField<K extends keyof ConnectorFormValues>(
    field: K,
    value: ConnectorFormValues[K]
  ) {
    setForm((previous) => ({ ...previous, [field]: value }))
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)

    const validation = validateConnectorForm(form, isEditing)
    if (!validation.valid) {
      setError(validation.error)
      return
    }

    setIsSubmitting(true)
    try {
      const oauthCredentials = buildOAuthCredentials(form, isEditing)
      const commonPayload = {
        name: form.name,
        url: form.url,
        transport: form.transport,
        authType: form.authType,
        toolSource:
          form.authType === "oauth"
            ? form.toolSource
            : ("mcp" as McpToolSource),
        maxConnections: validation.maxConnections,
      }
      const result =
        isEditing && server
          ? await updateMcpServer({
              id: server.id,
              ...commonPayload,
              credentialsKey: form.credentialsKey || null,
              oauthCredentials,
            })
          : await createMcpServer({
              ...commonPayload,
              credentialsKey: form.credentialsKey || undefined,
              oauthCredentials: oauthCredentials ?? undefined,
            })

      if (!result.isSuccess) {
        setError(
          result.message ??
            (isEditing
              ? "Failed to update connector"
              : "Failed to create connector")
        )
        return
      }
      onSuccess()
    } catch {
      setError("An unexpected error occurred")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-6 space-y-4">
      <BasicConnectorFields
        form={form}
        setError={setError}
        updateField={updateField}
      />
      {form.authType === "oauth" && (
        <OAuthConnectorFields
          form={form}
          hasExistingCredentials={hasExistingOAuthCredentials}
          updateField={updateField}
        />
      )}
      <AuthSpecificFields form={form} updateField={updateField} />
      <ConnectorSubmitFields
        error={error}
        form={form}
        isEditing={isEditing}
        isSubmitting={isSubmitting}
        updateField={updateField}
      />
    </form>
  )
}
