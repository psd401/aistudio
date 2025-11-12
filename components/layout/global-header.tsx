"use client"

import Link from "next/link"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { UserButton } from "@/components/user/user-button"
import { NotificationBell } from "@/components/notifications/notification-bell"
import { MessageCenter } from "@/components/notifications/message-center"
import { useNotifications } from "@/contexts/notification-context"
import { useExecutionResults } from "@/hooks/use-execution-results"
import {
  Search,
  Sun,
  BookOpen,
  Bug,
  Check,
  X,
  Upload
} from "lucide-react"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { Textarea } from "@/components/ui/textarea"
import { useState, useRef, useEffect } from "react"
import { createFreshserviceTicketAction } from "@/actions/create-freshservice-ticket.actions"
import { toast } from "sonner"
// ... rest of imports ...

export function GlobalHeader() {
  const router = useRouter()

  // Get notification data
  const {
    notifications,
    unreadCount,
    isLoading: notificationsLoading,
    markAsRead,
    markAllAsRead,
  } = useNotifications()

  // Get execution results for message center
  const {
    results: executionResults,
    isLoading: resultsLoading,
  } = useExecutionResults({ limit: 10 })

  const handleViewResult = (resultId: number) => {
    router.push(`/execution-results/${resultId}`)
  }

  const handleRetryExecution = (scheduledExecutionId: number) => {
    // TODO: Implement retry execution functionality
    toast.info("Retry Execution feature coming soon", {
      description: `Schedule ID: ${scheduledExecutionId}`
    })
    // Future: router.push(`/schedules/${scheduledExecutionId}/retry`)
  }

  const handleDeleteResult = async (resultId: number) => {
    try {
      const response = await fetch(`/api/execution-results/${resultId}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error(`Failed to delete execution result: ${response.status}`)
      }

      toast.success("Execution result deleted successfully")

      // Refresh the execution results list
      // The useExecutionResults hook should automatically refetch
      window.location.reload()

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to delete execution result"
      toast.error(errorMessage)
    }
  }

  return (
    <header className="fixed top-0 z-50 w-full border-b border-border/40 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-14 max-w-screen-2xl items-center px-4 md:px-6">
        {/* Left Section: Logo and Title */}
        <div className="mr-4 flex items-center">
          <Link href="/dashboard" className="mr-6 flex items-center space-x-2">
            {/* Use the actual logo */}
            <Image
              src="/logo.png" // Use actual logo path
              alt="Logo"
              width={32}
              height={32}
              className="h-8 w-8 object-contain" // Adjust size as needed
            />
            {/* Change site name */}
            <span className="font-semibold text-lg inline-block">AI Studio</span>
          </Link>
        </div>

        {/* Center Section - Search */}
        <div className="flex flex-1 items-center justify-center space-x-2 ">
          <div className="relative w-full max-w-md">
            <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search..."
              className="h-9 w-full rounded-md border bg-card pl-8 shadow-none focus-visible:ring-0"
            />
          </div>
        </div>

        {/* Right Section - Navigation Icons with Notifications */}
        <div className="flex flex-1 items-center justify-end space-x-1 sm:space-x-2">
          {/* Hide theme and language buttons on mobile */}
          <Button variant="ghost" size="icon" aria-label="Toggle Theme" className="hidden sm:flex">
            <Sun className="h-5 w-5" />
          </Button>
          <Button variant="ghost" size="icon" aria-label="Open Prompt Library" className="hidden sm:flex" asChild>
            <Link href="/prompt-library">
              <BookOpen className="h-5 w-5" />
            </Link>
          </Button>

          {/* Message Center - Execution Results */}
          <MessageCenter
            messages={executionResults}
            onViewResult={handleViewResult}
            onRetryExecution={handleRetryExecution}
            onDeleteResult={handleDeleteResult}
            loading={resultsLoading}
          />

          {/* Notification Bell */}
          <NotificationBell
            unreadCount={unreadCount}
            notifications={notifications}
            onMarkRead={markAsRead}
            onMarkAllRead={markAllAsRead}
            loading={notificationsLoading}
          />

          {/* Bug Report Dropdown - Always show for now, or add auth check if needed */}
          <BugReportPopover />
          <UserButton />
        </div>
      </div>
    </header>
  )
}

function BugReportPopover() {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [screenshot, setScreenshot] = useState<File | null>(null)
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [success, setSuccess] = useState<{ url: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [consoleErrors, setConsoleErrors] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  
  // Capture console errors when the popover is opened
  interface WindowWithErrors extends Window {
    __capturedErrors?: string[]
  }

  useEffect(() => {
    if (open) {
      // Check if we have any stored console errors
      const storedErrors = (window as unknown as WindowWithErrors).__capturedErrors || []
      setConsoleErrors(storedErrors.slice(-10)) // Keep last 10 errors
    }
  }, [open])

  // Clean up preview URLs when component unmounts or screenshot changes
  useEffect(() => {
    return () => {
      if (screenshotPreview && screenshotPreview.startsWith('blob:')) {
        URL.revokeObjectURL(screenshotPreview)
      }
    }
  }, [screenshotPreview])

  const handleScreenshotChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    
    // Define allowed MIME types explicitly (match server-side validation)
    const ALLOWED_IMAGE_TYPES = [
      'image/jpeg',
      'image/jpg', 
      'image/png',
      'image/gif',
      'image/webp'
    ]
    
    if (file && ALLOWED_IMAGE_TYPES.includes(file.type)) {
      // Check file size (10MB limit)
      const maxSize = 10 * 1024 * 1024
      if (file.size > maxSize) {
        setError("Screenshot must be smaller than 10MB")
        return
      }
      
      setScreenshot(file)
      setError(null)
      
      // Clean up previous preview URL to prevent memory leaks
      if (screenshotPreview && screenshotPreview.startsWith('data:')) {
        // Data URLs don't need explicit cleanup, but object URLs would
      }
      
      // Create preview URL
      const reader = new FileReader()
      reader.onloadend = () => {
        setScreenshotPreview(reader.result as string)
      }
      reader.readAsDataURL(file)
    } else if (file) {
      setError("Only JPEG, PNG, GIF, and WebP images are supported")
    }
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items
    if (items) {
      // Define allowed MIME types explicitly (match server-side validation)
      const ALLOWED_IMAGE_TYPES = [
        'image/jpeg',
        'image/jpg', 
        'image/png',
        'image/gif',
        'image/webp'
      ]
      
      for (const item of items) {
        if (ALLOWED_IMAGE_TYPES.includes(item.type)) {
          const file = item.getAsFile()
          if (file) {
            setScreenshot(file)
            setError(null)
            
            // Clean up previous preview URL to prevent memory leaks
            if (screenshotPreview && screenshotPreview.startsWith('data:')) {
              // Data URLs don't need explicit cleanup, but object URLs would
            }
            
            // Create preview URL
            const reader = new FileReader()
            reader.onloadend = () => {
              setScreenshotPreview(reader.result as string)
            }
            reader.readAsDataURL(file)
            break
          }
        }
      }
    }
  }

  const clearScreenshot = () => {
    // Clean up preview URL if it's an object URL (though we're using data URLs, this is future-proofing)
    if (screenshotPreview && screenshotPreview.startsWith('blob:')) {
      URL.revokeObjectURL(screenshotPreview)
    }
    
    setScreenshot(null)
    setScreenshotPreview(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title || !description) return
    setLoading(true)
    setError(null)
    setSuccess(null)

    // Gather enhanced troubleshooting metadata
    const metadata = []
    
    // User's problem description
    metadata.push('<strong>=== USER DESCRIPTION ===</strong>')
    metadata.push(description)
    metadata.push('<br>') // Extra spacing after user description
    
    // Browser and System Information
    metadata.push('<br><strong>=== BROWSER & SYSTEM INFO ===</strong>')
    if (typeof window !== 'undefined') {
      metadata.push(`Page URL: ${window.location.href}`)
      metadata.push(`Page Title: ${document.title}`)
      metadata.push(`Referrer: ${document.referrer || 'Direct access'}`)
    }
    
    if (typeof navigator !== 'undefined') {
      metadata.push(`Browser: ${navigator.userAgent}`)
      metadata.push(`Platform: ${navigator.platform}`)
      metadata.push(`Language: ${navigator.language}`)
      metadata.push(`Online Status: ${navigator.onLine ? 'Online' : 'Offline'}`)
      metadata.push(`Cookies Enabled: ${navigator.cookieEnabled}`)
      
      // Memory info if available (Chrome)
      interface NavigatorWithExtras {
        deviceMemory?: number
        hardwareConcurrency: number
      }
      const nav = navigator as unknown as NavigatorWithExtras
      if (nav.deviceMemory) {
        metadata.push(`Device Memory: ${nav.deviceMemory} GB`)
      }
      if (nav.hardwareConcurrency) {
        metadata.push(`CPU Cores: ${nav.hardwareConcurrency}`)
      }
    }
    
    // Screen Information
    metadata.push('<br><br><strong>=== DISPLAY INFO ===</strong>')
    if (typeof window !== 'undefined') {
      metadata.push(`Screen Resolution: ${window.screen.width}x${window.screen.height}`)
      metadata.push(`Viewport Size: ${window.innerWidth}x${window.innerHeight}`)
      metadata.push(`Screen Color Depth: ${window.screen.colorDepth}-bit`)
      metadata.push(`Pixel Ratio: ${window.devicePixelRatio}`)
    }
    
    // Session Information
    metadata.push('<br><br><strong>=== SESSION INFO ===</strong>')
    metadata.push(`Timestamp: ${new Date().toISOString()}`)
    metadata.push(`Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`)
    
    // Local Storage Info (for debugging state issues)
    if (typeof window !== 'undefined' && window.localStorage) {
      metadata.push(`Local Storage Items: ${window.localStorage.length}`)
      
      // Check for auth session
      const authSession = window.localStorage.getItem('next-auth.session-token')
      metadata.push(`Authenticated: ${authSession ? 'Yes' : 'No'}`)
    }
    
    // Performance metrics if available
    metadata.push('<br><br><strong>=== PERFORMANCE METRICS ===</strong>')
    interface PerformanceWithMemory extends Performance {
      memory?: {
        usedJSHeapSize: number
        jsHeapSizeLimit: number
      }
    }
    if (typeof window !== 'undefined' && window.performance) {
      const perf = window.performance as PerformanceWithMemory
      if (perf.memory) {
        metadata.push(`JS Heap Used: ${Math.round(perf.memory.usedJSHeapSize / 1048576)} MB`)
        metadata.push(`JS Heap Limit: ${Math.round(perf.memory.jsHeapSizeLimit / 1048576)} MB`)
      }
    }
    
    // Network Information
    interface NavigatorWithConnection extends Navigator {
      connection?: {
        effectiveType?: string
        downlink?: number
        saveData?: boolean
      }
    }
    const navWithConnection = navigator as NavigatorWithConnection
    if (typeof navigator !== 'undefined' && navWithConnection.connection) {
      const connection = navWithConnection.connection
      metadata.push('<br><br><strong>=== NETWORK INFO ===</strong>')
      metadata.push(`Connection Type: ${connection.effectiveType || 'Unknown'}`)
      if (connection.downlink) {
        metadata.push(`Downlink Speed: ${connection.downlink} Mbps`)
      }
      metadata.push(`Data Saver: ${connection.saveData ? 'Enabled' : 'Disabled'}`)
    }
    
    // Console Errors (if any)
    if (consoleErrors.length > 0) {
      metadata.push('<br><br><strong>=== RECENT CONSOLE ERRORS ===</strong>')
      for (const [index, err] of consoleErrors.entries()) {
        metadata.push(`Error ${index + 1}: ${err}`)
      }
    }
    
    // Join with HTML line breaks for proper Freshservice formatting
    const fullDescription = metadata.join('<br>')

    // Prepare FormData for server action
    const formData = new FormData()
    formData.append('title', title)
    formData.append('description', fullDescription)
    
    if (screenshot) {
      formData.append('screenshot', screenshot)
    }

    const res = await createFreshserviceTicketAction(formData)
    setLoading(false)
    if (res.isSuccess) {
      setSuccess({ url: res.data.ticket_url })
      setTitle("")
      setDescription("")
      clearScreenshot()
    } else {
      setError(res.message || "Failed to create ticket.")
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Submit Issue">
          <Bug className="h-5 w-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        {success ? (
          <div className="flex flex-col items-center space-y-2">
            <Check className="h-8 w-8 text-green-500" />
            <div className="text-green-700 font-semibold">Ticket created!</div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4" onPaste={handlePaste}>
            <div>
              <label htmlFor="feedback-title" className="block text-sm font-medium mb-1">Title</label>
              <Input
                id="feedback-title"
                value={title}
                onChange={e => setTitle(e.target.value)}
                required
                placeholder="Short summary"
                disabled={loading}
              />
            </div>
            <div>
              <label htmlFor="feedback-description" className="block text-sm font-medium mb-1">Description</label>
              <Textarea
                id="feedback-description"
                value={description}
                onChange={e => setDescription(e.target.value)}
                required
                placeholder="Describe the issue or suggestion"
                disabled={loading}
              />
            </div>

            {/* Screenshot upload section */}
            <div>
              <div className="block text-sm font-medium mb-1" aria-label="Screenshot (optional)">Screenshot (optional)</div>
              <div className="space-y-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={loading}
                  className="w-full"
                >
                  <Upload className="h-4 w-4 mr-1" />
                  Upload Screenshot
                </Button>
                
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleScreenshotChange}
                  className="hidden"
                />
                
                {screenshotPreview && (
                  <div className="relative">
                    <img
                      src={screenshotPreview}
                      alt="Screenshot preview"
                      className="max-w-full h-32 object-cover rounded border"
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="absolute top-1 right-1 h-6 w-6 bg-white/80 hover:bg-white"
                      onClick={clearScreenshot}
                      disabled={loading}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                )}
                
                <div className="text-xs text-muted-foreground">
                  Tip: You can also paste images directly (Ctrl/Cmd+V)
                </div>
              </div>
            </div>
            
            {error && <div className="text-red-600 text-sm">{error}</div>}
            <Button type="submit" disabled={loading || !title || !description}>
              {loading ? "Creating ticket..." : "Create Ticket"}
            </Button>
          </form>
        )}
      </PopoverContent>
    </Popover>
  )
}
