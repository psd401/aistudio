"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import { createLogger } from "@/lib/client-logger"
import { createUserApiKey } from "@/actions/settings/user-settings.actions"
import { API_SCOPES, getScopesForRoles, type ApiScope } from "@/lib/api-keys/scopes"

const log = createLogger({ component: "ApiKeyCreateDialog" })

// ============================================
// Component
// ============================================

interface ApiKeyCreateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onKeyCreated: (rawKey: string) => void
  userRoles: string[]
}

export function ApiKeyCreateDialog({
  open,
  onOpenChange,
  onKeyCreated,
  userRoles,
}: ApiKeyCreateDialogProps) {
  const [name, setName] = useState("")
  const [selectedScopes, setSelectedScopes] = useState<string[]>([])
  const [expiresIn, setExpiresIn] = useState("90")
  const [isCreating, setIsCreating] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [scopeError, setScopeError] = useState<string | null>(null)

  const availableScopes = getScopesForRoles(userRoles)

  function toggleScope(scope: string) {
    setSelectedScopes((prev) =>
      prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
    )
    setScopeError(null)
  }

  function resetForm() {
    setName("")
    setSelectedScopes([])
    setExpiresIn("90")
    setNameError(null)
    setScopeError(null)
  }

  async function handleCreate() {
    // Validate
    const trimmedName = name.trim()
    if (!trimmedName) {
      setNameError("Key name is required")
      return
    }
    if (trimmedName.length > 100) {
      setNameError("Key name must be 100 characters or less")
      return
    }
    if (selectedScopes.length === 0) {
      setScopeError("Select at least one scope")
      return
    }

    setIsCreating(true)
    try {
      let expiresAt: Date | undefined
      if (expiresIn !== "never") {
        expiresAt = new Date()
        expiresAt.setDate(expiresAt.getDate() + Number(expiresIn))
      }

      const result = await createUserApiKey({
        name: trimmedName,
        scopes: selectedScopes,
        expiresAt,
      })

      if (result.isSuccess) {
        onKeyCreated(result.data.rawKey)
        resetForm()
      } else {
        toast.error(result.message)
      }
    } catch (error) {
      log.error("API key creation failed", { error: error instanceof Error ? error.message : String(error) })
      toast.error("Failed to create API key")
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) resetForm()
        onOpenChange(isOpen)
      }}
    >
      <DialogContent className="sm:max-w-2xl flex flex-col max-h-[85vh]">
        <DialogHeader className="shrink-0">
          <DialogTitle>Generate API Key</DialogTitle>
          <DialogDescription>
            Create a key to access AI Studio via the API. The key will be
            shown once after creation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2 overflow-y-auto min-h-0">
          {/* Name */}
          <div className="space-y-2">
            <Label htmlFor="key-name">Key Name</Label>
            <Input
              id="key-name"
              placeholder="e.g., Production Integration"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setNameError(null)
              }}
              maxLength={100}
            />
            {nameError && (
              <p className="text-sm text-destructive">{nameError}</p>
            )}
          </div>

          {/* Scopes */}
          <div className="space-y-2">
            <Label>Scopes</Label>
            {availableScopes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No API scopes are available for your role.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {availableScopes.map((scope) => (
                  <label
                    key={scope}
                    className="flex items-start gap-3 rounded-md border p-3 cursor-pointer hover:bg-accent/50"
                  >
                    <Checkbox
                      checked={selectedScopes.includes(scope)}
                      onCheckedChange={() => toggleScope(scope)}
                      className="mt-0.5"
                    />
                    <div>
                      <span className="text-sm font-medium">{scope}</span>
                      <p className="text-xs text-muted-foreground">
                        {API_SCOPES[scope as ApiScope]}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            )}
            {scopeError && (
              <p className="text-sm text-destructive">{scopeError}</p>
            )}
          </div>

          {/* Expiration */}
          <div className="space-y-2">
            <Label htmlFor="expires-in">Expiration</Label>
            <Select value={expiresIn} onValueChange={setExpiresIn}>
              <SelectTrigger id="expires-in">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30">30 days</SelectItem>
                <SelectItem value="90">90 days (Recommended)</SelectItem>
                <SelectItem value="365">1 year</SelectItem>
                <SelectItem value="never">No expiration</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter className="shrink-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isCreating}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={isCreating || availableScopes.length === 0}
          >
            {isCreating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create Key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
