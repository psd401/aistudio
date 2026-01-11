'use client'

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { ConversationList } from '@/components/nexus/conversation-list'
import { useMediaQuery } from '@/lib/hooks/use-media-query'

interface ConversationPanelProps {
  selectedConversationId?: string | null
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}

export function ConversationPanel({ selectedConversationId, isOpen, onOpenChange }: ConversationPanelProps) {
  const isMobile = useMediaQuery('(max-width: 640px)')

  if (isMobile) {
    return (
      <Drawer open={isOpen} onOpenChange={onOpenChange}>
        <DrawerContent className="h-[80vh]">
          <DrawerHeader>
            <DrawerTitle>Conversations</DrawerTitle>
          </DrawerHeader>

          <div className="flex-1 overflow-y-auto px-4 pb-4 max-h-[calc(80vh-6rem)]">
            <ConversationList
              selectedConversationId={selectedConversationId}
            />
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Sheet open={isOpen} onOpenChange={onOpenChange}>
      <SheetContent position="right" className="w-[400px]">
        <SheetHeader>
          <SheetTitle>Conversations</SheetTitle>
        </SheetHeader>

        <div className="flex-1 overflow-y-auto mt-4 max-h-[calc(100vh-8rem)]">
          <ConversationList
            selectedConversationId={selectedConversationId}
          />
        </div>
      </SheetContent>
    </Sheet>
  )
}
