"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Key, Plus, Loader2 } from "lucide-react"
import { formatDistanceToNow } from "date-fns"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

import { createLogger } from "@/lib/client-logger"
import { ApiKeyCreateDialog } from "./api-key-create-dialog"
import { ApiKeyCreatedDisplay } from "./api-key-created-display"
import {
  listUserApiKeys,
  revokeUserApiKey,
} from "@/actions/settings/user-settings.actions"
import type { ApiKeyInfo } from "@/lib/api-keys/key-service"

const log = createLogger({ component: "ApiKeysTab" })

// ============================================
// Component
// ============================================

interface ApiKeysTabProps {
  initialKeys: ApiKeyInfo[]
  userRoles: string[]
}

function getKeyStatus(key: ApiKeyInfo) {
  if (key.revokedAt) return { label: "Revoked", variant: "destructive" as const }
  if (key.expiresAt && new Date(key.expiresAt) < new Date())
    return { label: "Expired", variant: "secondary" as const }
  if (!key.isActive) return { label: "Inactive", variant: "secondary" as const }
  return { label: "Active", variant: "default" as const }
}

export function ApiKeysTab({ initialKeys, userRoles }: ApiKeysTabProps) {
  const [keys, setKeys] = useState<ApiKeyInfo[]>(initialKeys)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyInfo | null>(null)
  const [isRevoking, setIsRevoking] = useState(false)

  async function refreshKeys() {
    const result = await listUserApiKeys()
    if (result.isSuccess) {
      setKeys(result.data)
    }
  }

  async function handleKeyCreated(rawKey: string) {
    setShowCreateDialog(false)
    setCreatedKey(rawKey)
    await refreshKeys()
  }

  async function handleRevoke() {
    if (!revokeTarget) return
    setIsRevoking(true)
    try {
      const result = await revokeUserApiKey(revokeTarget.id)
      if (result.isSuccess) {
        toast.success(result.message)
        await refreshKeys()
      } else {
        toast.error(result.message)
      }
    } catch (error) {
      log.error("API key revocation failed", { error: error instanceof Error ? error.message : String(error) })
      toast.error("Failed to revoke API key")
    } finally {
      setIsRevoking(false)
      setRevokeTarget(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>API Keys</CardTitle>
            <CardDescription>
              Generate API keys to access AI Studio programmatically.
              Keys are shown once at creation and cannot be retrieved later.
            </CardDescription>
          </div>
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Generate Key
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Show-once display for newly created key */}
        {createdKey && (
          <ApiKeyCreatedDisplay
            rawKey={createdKey}
            onDismiss={() => setCreatedKey(null)}
          />
        )}

        {/* Key list */}
        {keys.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Key className="h-6 w-6 text-muted-foreground" />
            </div>
            <h3 className="font-semibold">No API Keys</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Create an API key to integrate AI Studio with your
              applications. You can have up to 10 active keys.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {keys.map((key) => {
              const status = getKeyStatus(key)
              return (
                <div
                  key={key.id}
                  className="flex items-start justify-between rounded-lg border p-4"
                >
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{key.name}</span>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </div>
                    <p className="font-mono text-sm text-muted-foreground">
                      sk-{key.keyPrefix}{"••••••••"}
                    </p>
                    {key.scopes.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {key.scopes.map((scope) => (
                          <Badge key={scope} variant="outline" className="text-xs">
                            {scope}
                          </Badge>
                        ))}
                      </div>
                    )}
                    <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                      <span>
                        Created{" "}
                        {formatDistanceToNow(new Date(key.createdAt), {
                          addSuffix: true,
                        })}
                      </span>
                      {key.lastUsedAt && (
                        <span>
                          Last used{" "}
                          {formatDistanceToNow(new Date(key.lastUsedAt), {
                            addSuffix: true,
                          })}
                        </span>
                      )}
                      {key.expiresAt && (
                        <span>
                          Expires{" "}
                          {formatDistanceToNow(new Date(key.expiresAt), {
                            addSuffix: true,
                          })}
                        </span>
                      )}
                    </div>
                  </div>
                  {!key.revokedAt && key.isActive && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setRevokeTarget(key)}
                    >
                      Revoke
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </CardContent>

      {/* Create Dialog */}
      <ApiKeyCreateDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onKeyCreated={handleKeyCreated}
        userRoles={userRoles}
      />

      {/* Revoke Confirmation */}
      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API Key?</AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <p>
                This action cannot be undone. All applications using the key{" "}
                <strong>&ldquo;{revokeTarget?.name}&rdquo;</strong> will
                immediately lose access.
              </p>
              {revokeTarget?.lastUsedAt && (
                <p className="text-xs">
                  Last used:{" "}
                  {formatDistanceToNow(new Date(revokeTarget.lastUsedAt), {
                    addSuffix: true,
                  })}
                </p>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRevoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRevoke}
              disabled={isRevoking}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isRevoking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Revoke Key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
