'use client'

import { Button } from '@/components/ui/button'
import { PanelLeft, PanelLeftClose } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SidebarMode } from '@/lib/hooks/use-sidebar-state'

interface SidebarToggleProps {
  isCollapsed: boolean
  mode: SidebarMode
  onToggle: () => void
  className?: string
}

/**
 * Toggle button for the sidebar.
 * Shows different icons based on collapsed state.
 */
export function SidebarToggle({
  isCollapsed,
  mode,
  onToggle,
  className,
}: SidebarToggleProps) {
  const label = mode === 'persistent'
    ? isCollapsed
      ? 'Expand sidebar'
      : 'Collapse sidebar'
    : 'Open conversations'

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onToggle}
      className={cn('h-9 w-9', className)}
      aria-label={label}
      title={label}
    >
      {mode === 'persistent' && !isCollapsed ? (
        <PanelLeftClose className="h-5 w-5" />
      ) : (
        <PanelLeft className="h-5 w-5" />
      )}
    </Button>
  )
}
