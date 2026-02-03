'use client'

import { ReactNode, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { navigateToNewConversation } from '@/lib/nexus/conversation-navigation'
import type { SidebarMode } from '@/lib/hooks/use-sidebar-state'

interface NexusSidebarProps {
  isOpen: boolean
  isCollapsed: boolean
  mode: SidebarMode
  onClose: () => void
  children: ReactNode
}

/**
 * Responsive sidebar container for Nexus conversations.
 *
 * Behavior by mode:
 * - persistent: Always visible on desktop, can collapse to 0 width
 * - overlay: Sheet that slides in from left (tablet)
 * - drawer: Bottom drawer (mobile)
 */
export function NexusSidebar({
  isOpen,
  isCollapsed,
  mode,
  onClose,
  children,
}: NexusSidebarProps) {
  // Handler for opening changes - close when set to false
  const handleOpenChange = useCallback((open: boolean) => {
    if (!open) {
      onClose()
    }
  }, [onClose])

  // Handler for new chat button in overlay/drawer modes
  const handleNewChatWithClose = useCallback(() => {
    onClose()
    navigateToNewConversation()
  }, [onClose])

  // Mobile drawer
  if (mode === 'drawer') {
    return (
      <Drawer open={isOpen} onOpenChange={handleOpenChange}>
        <DrawerContent className="h-[85vh]">
          <DrawerHeader className="border-b">
            <div className="flex items-center justify-between">
              <DrawerTitle>Conversations</DrawerTitle>
              <Button
                variant="default"
                size="sm"
                onClick={handleNewChatWithClose}
                className="flex items-center gap-1.5"
              >
                <Plus className="h-4 w-4" />
                New Chat
              </Button>
            </div>
          </DrawerHeader>
          <div className="flex-1 overflow-y-auto px-4 pb-4 pt-2">
            {children}
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  // Tablet overlay
  if (mode === 'overlay') {
    return (
      <Sheet open={isOpen} onOpenChange={handleOpenChange}>
        <SheetContent position="left" className="w-[320px] p-0">
          <SheetHeader className="border-b px-4 py-3">
            <div className="flex items-center justify-between">
              <SheetTitle>Conversations</SheetTitle>
              <Button
                variant="default"
                size="sm"
                onClick={handleNewChatWithClose}
                className="flex items-center gap-1.5"
              >
                <Plus className="h-4 w-4" />
                New Chat
              </Button>
            </div>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-4">
            {children}
          </div>
        </SheetContent>
      </Sheet>
    )
  }

  // Desktop persistent sidebar
  return (
    <aside
      className={cn(
        'h-full border-r bg-muted/20 transition-all duration-200 ease-out flex flex-col',
        isCollapsed ? 'w-0 overflow-hidden border-r-0' : 'w-[280px]'
      )}
    >
      {!isCollapsed && (
        <>
          {/* Sidebar Header */}
          <div className="flex items-center justify-between border-b px-4 py-3">
            <h2 className="text-sm font-semibold">Conversations</h2>
            <Button
              variant="default"
              size="sm"
              onClick={navigateToNewConversation}
              className="flex items-center gap-1.5"
            >
              <Plus className="h-4 w-4" />
              New Chat
            </Button>
          </div>

          {/* Conversation List */}
          <div className="flex-1 h-0 overflow-y-auto p-3">
            {children}
          </div>
        </>
      )}
    </aside>
  )
}
