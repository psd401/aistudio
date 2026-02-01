"use client"

import { useState } from "react"
import { Copy, Check, AlertTriangle } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

// ============================================
// Component
// ============================================

interface ApiKeyCreatedDisplayProps {
  rawKey: string
  onDismiss: () => void
}

export function ApiKeyCreatedDisplay({
  rawKey,
  onDismiss,
}: ApiKeyCreatedDisplayProps) {
  const [copied, setCopied] = useState(false)

  async function copyToClipboard() {
    try {
      await navigator.clipboard.writeText(rawKey)
      setCopied(true)
      toast.success("API key copied to clipboard")
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error("Failed to copy to clipboard")
    }
  }

  return (
    <AlertDialog open onOpenChange={() => {}}>
      <AlertDialogContent className="sm:max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Save Your API Key
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4">
              <p>
                Copy this key now. For security, it will not be shown again.
                If you lose it, you&apos;ll need to generate a new one.
              </p>
              <div className="flex gap-2">
                <code className="flex-1 break-all rounded-md border-2 border-amber-200 bg-amber-50 p-3 font-mono text-sm text-foreground dark:border-amber-800 dark:bg-amber-950">
                  {rawKey}
                </code>
                <Button
                  size="lg"
                  onClick={copyToClipboard}
                  className="min-w-[100px] shrink-0"
                  aria-label="Copy API key to clipboard"
                >
                  {copied ? (
                    <>
                      <Check className="mr-2 h-4 w-4" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="mr-2 h-4 w-4" />
                      Copy
                    </>
                  )}
                </Button>
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction onClick={onDismiss}>
            I&apos;ve saved my key
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
