"use client"

import { useState, useRef, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/components/ui/use-toast"
import { Upload, ImageIcon, RotateCcw } from "lucide-react"
import { uploadBrandingLogoAction, resetBrandingLogoAction } from "@/actions/db/settings-actions"
import Image from "next/image"

interface LogoUploadProps {
  currentLogoUrl: string
}

export function LogoUpload({ currentLogoUrl }: LogoUploadProps) {
  const [isUploading, setIsUploading] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string>(currentLogoUrl)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const { toast } = useToast()

  useEffect(() => {
    setPreviewUrl(currentLogoUrl)
  }, [currentLogoUrl])

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Client-side pre-validation (server re-validates with magic bytes)
    const allowedTypes = ["image/png", "image/jpeg", "image/webp"]
    if (!allowedTypes.includes(file.type)) {
      toast({
        title: "Invalid file type",
        description: "Accepted formats: PNG, JPEG, WebP",
        variant: "destructive"
      })
      return
    }

    if (file.size > 2 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Maximum logo size is 2MB",
        variant: "destructive"
      })
      return
    }

    setIsUploading(true)
    try {
      const formData = new FormData()
      formData.append("file", file)

      const result = await uploadBrandingLogoAction(formData)

      if (result.isSuccess) {
        setPreviewUrl(result.data)
        toast({
          title: "Logo uploaded",
          description: "The branding logo has been updated. Changes will appear across the application."
        })
      } else {
        toast({
          title: "Upload failed",
          description: result.message,
          variant: "destructive"
        })
      }
    } catch {
      toast({
        title: "Upload failed",
        description: "An unexpected error occurred",
        variant: "destructive"
      })
    } finally {
      setIsUploading(false)
      // Reset the file input so the same file can be re-selected
      if (fileInputRef.current) {
        fileInputRef.current.value = ""
      }
    }
  }

  const handleReset = async () => {
    setIsResetting(true)
    try {
      const result = await resetBrandingLogoAction()
      if (result.isSuccess) {
        setPreviewUrl("/logo.png")
        toast({
          title: "Logo reset",
          description: "The logo has been reset to the application default."
        })
      } else {
        toast({
          title: "Reset failed",
          description: result.message,
          variant: "destructive"
        })
      }
    } catch {
      toast({
        title: "Reset failed",
        description: "An unexpected error occurred",
        variant: "destructive"
      })
    } finally {
      setIsResetting(false)
    }
  }

  const isCustomLogo = previewUrl !== "/logo.png" && previewUrl !== ""

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Organization Logo</CardTitle>
        <CardDescription>
          Upload your organization&apos;s logo. Accepted formats: PNG, JPEG, WebP. Max 2MB.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-6">
          <div className="relative h-16 w-16 shrink-0 rounded-lg border bg-muted flex items-center justify-center overflow-hidden">
            {previewUrl ? (
              <Image
                src={previewUrl}
                alt="Organization logo"
                fill
                className="object-contain p-1"
                unoptimized={!previewUrl.startsWith("/")}
                onError={() => setPreviewUrl("")}
              />
            ) : (
              <ImageIcon className="h-8 w-8 text-muted-foreground" />
            )}
          </div>
          <div className="flex flex-col gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleFileSelect}
              className="hidden"
            />
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading || isResetting}
              >
                <Upload className="h-4 w-4 mr-2" />
                {isUploading ? "Uploading..." : "Upload Logo"}
              </Button>
              {isCustomLogo && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleReset}
                  disabled={isUploading || isResetting}
                >
                  <RotateCcw className="h-4 w-4 mr-2" />
                  {isResetting ? "Resetting..." : "Reset to Default"}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              This logo appears in the navigation bar and page headers. Accepted: PNG, JPEG, WebP (max 2MB).
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
