"use client"

import { useState, useCallback } from "react"
import { SettingsTable } from "./settings-table"
import { SettingsForm } from "./settings-form"
import { useToast } from "@/components/ui/use-toast"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { RefreshCw, Upload } from "lucide-react"
import type { Setting, CreateSettingInput } from "@/actions/db/settings-actions"

interface SettingsClientProps {
  initialSettings: Setting[]
}

export function SettingsClient({ initialSettings }: SettingsClientProps) {
  const [settings, setSettings] = useState(initialSettings)
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [editingSetting, setEditingSetting] = useState<Setting | null>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const { toast } = useToast()

  // Group settings by category
  const settingsByCategory = settings.reduce((acc, setting) => {
    const category = setting.category || 'uncategorized'
    if (!acc[category]) {
      acc[category] = []
    }
    acc[category].push(setting)
    return acc
  }, {} as Record<string, Setting[]>)

  const handleEdit = useCallback((setting: Setting) => {
    setEditingSetting(setting)
    setIsFormOpen(true)
  }, [])

  const handleDelete = useCallback(async (key: string) => {
    try {
      const response = await fetch(`/api/admin/settings?key=${key}`, {
        method: 'DELETE'
      })

      if (!response.ok) {
        throw new Error('Failed to delete setting')
      }

      const result = await response.json()
      if (result.isSuccess) {
        setSettings(settings.filter(s => s.key !== key))
        toast({
          title: "Success",
          description: "Setting deleted successfully"
        })
      } else {
        throw new Error(result.message)
      }
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to delete setting",
        variant: "destructive"
      })
    }
  }, [settings, toast])

  const handleSave = useCallback(async (data: CreateSettingInput) => {
    try {
      const response = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })

      if (!response.ok) {
        throw new Error('Failed to save setting')
      }

      const result = await response.json()
      
      if (result.isSuccess) {
        // Update the settings list
        const updatedSetting = result.data
        
        const existingIndex = settings.findIndex(s => s.key === updatedSetting.key)
        
        if (existingIndex >= 0) {
          const newSettings = [
            ...settings.slice(0, existingIndex),
            updatedSetting,
            ...settings.slice(existingIndex + 1)
          ]
          setSettings(newSettings)
        } else {
          setSettings([...settings, updatedSetting])
        }

        toast({
          title: "Success",
          description: "Setting saved successfully"
        })
        
        // Close the form and clear editing state
        // Use setTimeout to ensure state updates after current render cycle
        setTimeout(() => {
          setEditingSetting(null)
          setIsFormOpen(false)
        }, 0)
      } else {
        throw new Error(result.message || 'Unknown error')
      }
    } catch (error) {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to save setting",
        variant: "destructive"
      })
      // Re-throw the error so the form knows the save failed
      throw error
    }
  }, [settings, toast])

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true)
    try {
      const response = await fetch('/api/admin/settings')
      if (!response.ok) {
        throw new Error('Failed to refresh settings')
      }

      const result = await response.json()
      if (result.isSuccess) {
        setSettings(result.data)
        toast({
          title: "Success",
          description: "Settings refreshed successfully"
        })
      }
    } catch {
      toast({
        title: "Error",
        description: "Failed to refresh settings",
        variant: "destructive"
      })
    } finally {
      setIsRefreshing(false)
    }
  }, [toast])

  const handleImportFromEnv = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/settings/import', {
        method: 'POST'
      })

      if (!response.ok) {
        throw new Error('Failed to import settings')
      }

      const result = await response.json()
      if (result.isSuccess) {
        await handleRefresh()
        toast({
          title: "Success",
          description: `Imported ${result.data.imported} settings from environment variables`
        })
      }
    } catch {
      toast({
        title: "Error",
        description: "Failed to import settings from environment",
        variant: "destructive"
      })
    }
  }, [handleRefresh, toast])

  const categoryInfo: Record<string, { title: string; description: string }> = {
    ai: {
      title: "AI Configuration",
      description: "AI prompts, embeddings, and model configuration"
    },
    ai_providers: {
      title: "AI Providers",
      description: "API keys and configuration for AI model providers"
    },
    storage: {
      title: "Storage",
      description: "Configuration for file storage services"
    },
    external_services: {
      title: "External Services",
      description: "API keys and configuration for external integrations"
    },
    embeddings: {
      title: "Embeddings",
      description: "Configuration for embedding generation and vector search"
    },
    uncategorized: {
      title: "Other",
      description: "Uncategorized settings"
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Configuration Settings</CardTitle>
              <CardDescription>
                Manage application settings and API keys. Changes take effect immediately.
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleImportFromEnv}
                disabled={isRefreshing}
              >
                <Upload className="h-4 w-4 mr-2" />
                Import from Environment
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefresh}
                disabled={isRefreshing}
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setEditingSetting(null)
                  setIsFormOpen(true)
                }}
              >
                Add Setting
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="ai_providers" className="space-y-4">
            <TabsList>
              {Object.entries(categoryInfo).map(([key, info]) => {
                const count = settingsByCategory[key]?.length || 0
                if (count === 0 && key !== 'uncategorized') return null
                
                return (
                  <TabsTrigger key={key} value={key}>
                    {info.title}
                    <Badge variant="secondary" className="ml-2">
                      {count}
                    </Badge>
                  </TabsTrigger>
                )
              })}
            </TabsList>

            {Object.entries(categoryInfo).map(([key, info]) => {
              const categorySettings = settingsByCategory[key] || []
              if (categorySettings.length === 0 && key !== 'uncategorized') return null

              return (
                <TabsContent key={key} value={key} className="space-y-4">
                  <div>
                    <h3 className="font-medium">{info.title}</h3>
                    <p className="text-sm text-muted-foreground">{info.description}</p>
                  </div>
                  <SettingsTable
                    settings={categorySettings}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                  />
                </TabsContent>
              )
            })}
          </Tabs>
        </CardContent>
      </Card>

      <SettingsForm
        open={isFormOpen}
        onOpenChange={setIsFormOpen}
        onSave={handleSave}
        setting={editingSetting}
      />
    </div>
  )
}