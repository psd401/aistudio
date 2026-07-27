"use client"

import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { 
  MoreHorizontal, 
  Edit, 
  Trash, 
  Eye, 
  EyeOff, 
  Copy,
 
} from "lucide-react"
import { useToast } from "@/components/ui/use-toast"
import type { Setting } from "@/actions/db/settings-actions"
import { getSettingActualValueAction } from "@/actions/db/settings-actions"

interface SettingsTableProps {
  settings: Setting[]
  onEdit: (setting: Setting) => void
  onDelete: (key: string) => void
}

function SettingValue({
  setting,
  visible,
  actualValue,
  loading,
  onToggle,
  onCopy,
}: {
  setting: Setting
  visible: boolean
  actualValue?: string
  loading: boolean
  onToggle: () => void
  onCopy: () => void
}) {
  const hasValue =
    setting.hasValue || Boolean(setting.value && setting.value !== "••••••••")
  return (
    <div className="flex items-center gap-2">
      {setting.isSecret && hasValue ? (
        <div className="flex flex-1 items-center gap-2">
          <Input
            type={visible ? "text" : "password"}
            value={visible ? actualValue || setting.value || "" : "••••••••"}
            readOnly
            className="max-w-xs font-mono text-sm"
          />
          <Button
            variant="ghost"
            size="icon"
            onClick={onToggle}
            disabled={loading}
          >
            {loading ? (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : visible ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </Button>
        </div>
      ) : (
        <span
          className={
            hasValue ? "font-mono text-sm" : "text-muted-foreground"
          }
        >
          {hasValue ? setting.value : "Not set"}
        </span>
      )}
      {hasValue && (
        <Button variant="ghost" size="icon" onClick={onCopy}>
          <Copy className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
}

function SettingRow({
  setting,
  visible,
  actualValue,
  loading,
  onToggleVisibility,
  onCopy,
  onEdit,
  onDeleteRequest,
}: {
  setting: Setting
  visible: boolean
  actualValue?: string
  loading: boolean
  onToggleVisibility: () => void
  onCopy: () => void
  onEdit: () => void
  onDeleteRequest: () => void
}) {
  return (
    <TableRow>
      <TableCell className="font-mono text-sm">{setting.key}</TableCell>
      <TableCell>
        <SettingValue
          setting={setting}
          visible={visible}
          actualValue={actualValue}
          loading={loading}
          onToggle={onToggleVisibility}
          onCopy={onCopy}
        />
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {setting.description}
      </TableCell>
      <TableCell>
        <Badge variant={setting.isSecret ? "secondary" : "outline"}>
          {setting.isSecret ? "Secret" : "Public"}
        </Badge>
      </TableCell>
      <TableCell>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive"
              onClick={onDeleteRequest}
            >
              <Trash className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  )
}

function SettingsRows({
  settings,
  visibleValues,
  actualValues,
  loadingValues,
  onToggleVisibility,
  onCopy,
  onEdit,
  onDeleteRequest,
}: {
  settings: Setting[]
  visibleValues: Set<string>
  actualValues: Record<string, string>
  loadingValues: Set<string>
  onToggleVisibility: (key: string) => void
  onCopy: (setting: Setting) => void
  onEdit: (setting: Setting) => void
  onDeleteRequest: (key: string) => void
}) {
  return (
    <TableBody>
      {settings.map((setting) => (
        <SettingRow
          key={setting.key}
          setting={setting}
          visible={visibleValues.has(setting.key)}
          actualValue={actualValues[setting.key]}
          loading={loadingValues.has(setting.key)}
          onToggleVisibility={() => onToggleVisibility(setting.key)}
          onCopy={() => onCopy(setting)}
          onEdit={() => onEdit(setting)}
          onDeleteRequest={() => onDeleteRequest(setting.key)}
        />
      ))}
    </TableBody>
  )
}

export function SettingsTable({ settings, onEdit, onDelete }: SettingsTableProps) {
  const [visibleValues, setVisibleValues] = useState<Set<string>>(new Set())
  const [actualValues, setActualValues] = useState<Record<string, string>>({})
  const [loadingValues, setLoadingValues] = useState<Set<string>>(new Set())
  const [deleteKey, setDeleteKey] = useState<string | null>(null)
  const { toast } = useToast()

  const toggleValueVisibility = async (key: string) => {
    const newVisible = new Set(visibleValues)
    if (newVisible.has(key)) {
      // Hide the value
      newVisible.delete(key)
      setVisibleValues(newVisible)
    } else {
      // Show the value - fetch it if it's a secret and we don't have it yet
      const setting = settings.find(s => s.key === key)
      if (setting?.isSecret && !actualValues[key]) {
        // Fetch the actual value
        const newLoading = new Set(loadingValues)
        newLoading.add(key)
        setLoadingValues(newLoading)
        
        try {
          const result = await getSettingActualValueAction(key)
          if (result.isSuccess && result.data) {
            setActualValues(prev => ({ ...prev, [key]: result.data || '' }))
          }
        } catch {
          toast({
            title: "Error",
            description: "Failed to fetch value",
            variant: "destructive"
          })
        } finally {
          const newLoading = new Set(loadingValues)
          newLoading.delete(key)
          setLoadingValues(newLoading)
        }
      }
      
      newVisible.add(key)
      setVisibleValues(newVisible)
    }
  }

  const copyToClipboard = async (setting: Setting) => {
    try {
      let valueToCopy = setting.value || ''
      
      // If it's a secret with a value, fetch the actual value
      if (setting.isSecret && setting.hasValue) {
        const result = await getSettingActualValueAction(setting.key)
        if (result.isSuccess && result.data) {
          valueToCopy = result.data
        }
      }
      
      await navigator.clipboard.writeText(valueToCopy)
      toast({
        title: "Copied",
        description: "Value copied to clipboard"
      })
    } catch {
      toast({
        title: "Error",
        description: "Failed to copy value",
        variant: "destructive"
      })
    }
  }


  if (settings.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No settings found in this category
      </div>
    )
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Key</TableHead>
            <TableHead>Value</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="w-[100px]">Type</TableHead>
            <TableHead className="w-[50px]"></TableHead>
          </TableRow>
        </TableHeader>
        <SettingsRows
          settings={settings}
          visibleValues={visibleValues}
          actualValues={actualValues}
          loadingValues={loadingValues}
          onToggleVisibility={toggleValueVisibility}
          onCopy={copyToClipboard}
          onEdit={onEdit}
          onDeleteRequest={setDeleteKey}
        />
      </Table>

      <AlertDialog open={!!deleteKey} onOpenChange={() => setDeleteKey(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Setting</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete the setting &quot;{deleteKey}&quot;? This action cannot be undone.
              The application will fall back to environment variables if available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteKey) {
                  onDelete(deleteKey)
                  setDeleteKey(null)
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
