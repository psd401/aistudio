"use client"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Info, X } from "lucide-react"

interface ModelFallbackBannerProps {
  originalModel: string
  fallbackModel: string
  onDismiss: () => void
}

export function ModelFallbackBanner({
  originalModel,
  fallbackModel,
  onDismiss
}: ModelFallbackBannerProps) {
  const displayOriginal = originalModel || 'an unknown model'
  const displayFallback = fallbackModel || 'the default model'

  return (
    <Alert className="mx-auto w-full max-w-[48rem] relative">
      <Info className="h-4 w-4" />
      <AlertDescription className="pr-8">
        This conversation was created with model <strong>{displayOriginal}</strong>, which is no longer available.
        Using <strong>{displayFallback}</strong> instead.
      </AlertDescription>
      <Button
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2 h-6 w-6"
        onClick={onDismiss}
      >
        <X className="h-3 w-3" />
        <span className="sr-only">Dismiss</span>
      </Button>
    </Alert>
  )
}
