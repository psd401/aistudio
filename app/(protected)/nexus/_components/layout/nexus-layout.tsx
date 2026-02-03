'use client'

import { ReactNode, createContext, useContext } from 'react'
import { useSidebarState, type UseSidebarStateReturn } from '@/lib/hooks/use-sidebar-state'
import { NexusSidebar } from './nexus-sidebar'
import { ConversationList } from '@/components/nexus/conversation-list'
import { cn } from '@/lib/utils'

// Context for sidebar state
const NexusSidebarContext = createContext<UseSidebarStateReturn | null>(null)

export function useNexusSidebar() {
  const context = useContext(NexusSidebarContext)
  if (!context) {
    throw new Error('useNexusSidebar must be used within NexusLayout')
  }
  return context
}

interface NexusLayoutProps {
  children: ReactNode
  conversationId?: string | null
  /** When set, filters sidebar conversations to this provider and hides tabs */
  provider?: string
  /** Override default conversation selection navigation */
  onConversationSelect?: (id: string) => void
  /** Override navigation when starting new conversation or deleting selected */
  onNewConversation?: () => void
}

/**
 * Root layout component for Nexus Chat.
 * Provides the sidebar and main content area with responsive behavior.
 */
export function NexusLayout({ children, conversationId, provider, onConversationSelect, onNewConversation }: NexusLayoutProps) {
  const sidebarState = useSidebarState()
  const { isOpen, isCollapsed, mode, close } = sidebarState

  return (
    <NexusSidebarContext.Provider value={sidebarState}>
      <div className="fixed inset-0 lg:left-[68px] flex overflow-hidden z-30">
        {/* Sidebar - persistent on desktop */}
        {mode === 'persistent' && (
          <NexusSidebar
            isOpen={isOpen}
            isCollapsed={isCollapsed}
            mode={mode}
            onClose={close}
            onNewConversation={onNewConversation}
          >
            <ConversationList selectedConversationId={conversationId} provider={provider} onConversationSelect={onConversationSelect} onNewConversation={onNewConversation} />
          </NexusSidebar>
        )}

        {/* Sidebar - overlay on tablet */}
        {mode === 'overlay' && (
          <NexusSidebar
            isOpen={isOpen}
            isCollapsed={isCollapsed}
            mode={mode}
            onClose={close}
            onNewConversation={onNewConversation}
          >
            <ConversationList selectedConversationId={conversationId} provider={provider} onConversationSelect={onConversationSelect} onNewConversation={onNewConversation} />
          </NexusSidebar>
        )}

        {/* Sidebar - drawer on mobile */}
        {mode === 'drawer' && (
          <NexusSidebar
            isOpen={isOpen}
            isCollapsed={isCollapsed}
            mode={mode}
            onClose={close}
            onNewConversation={onNewConversation}
          >
            <ConversationList selectedConversationId={conversationId} provider={provider} onConversationSelect={onConversationSelect} onNewConversation={onNewConversation} />
          </NexusSidebar>
        )}

        {/* Main Content Area */}
        <main className={cn(
          'flex-1 flex flex-col min-w-0 overflow-hidden transition-all duration-200',
        )}>
          {children}
        </main>
      </div>
    </NexusSidebarContext.Provider>
  )
}
