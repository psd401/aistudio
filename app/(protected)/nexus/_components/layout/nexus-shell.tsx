'use client'

import { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Plus } from 'lucide-react'
import { navigateToNewConversation } from '@/lib/nexus/conversation-navigation'
import { PageBranding } from '@/components/ui/page-branding'
import { SidebarToggle } from './sidebar-toggle'
import { useNexusSidebar } from './nexus-layout'
interface NexusShellProps {
  children: ReactNode
}

export function NexusShell({
  children,
}: NexusShellProps) {
  const { isCollapsed, mode, toggle } = useNexusSidebar()

  return (
    <div className="flex h-full flex-col p-4 sm:p-6" data-testid="nexus-shell">
      {/* Header */}
      <div className="mb-4">
        <PageBranding />
        <div className="flex items-center gap-3">
          <SidebarToggle
            isCollapsed={isCollapsed}
            mode={mode}
            onToggle={toggle}
          />
          <div className="flex-1">
            <h1 className="text-2xl font-semibold text-gray-900">Nexus Chat</h1>
          </div>
          {/* New Chat button - secondary location (also in sidebar) */}
          <Button
            variant="outline"
            size="sm"
            onClick={navigateToNewConversation}
            className="flex items-center gap-1.5"
            title="Start new chat"
          >
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">New Chat</span>
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <Card className="flex-1 overflow-hidden flex flex-col">
        <CardContent className="flex-1 overflow-hidden p-0">
          {children}
        </CardContent>
      </Card>
    </div>
  )
}
