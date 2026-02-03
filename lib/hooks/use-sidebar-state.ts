'use client'

import { useState, useEffect, useCallback } from 'react'
import { useMediaQuery } from '@/lib/hooks/use-media-query'

const SIDEBAR_STORAGE_KEY = 'nexus-sidebar-collapsed'

export type SidebarMode = 'persistent' | 'overlay' | 'drawer'

export interface SidebarState {
  isOpen: boolean
  isCollapsed: boolean
  mode: SidebarMode
}

export interface UseSidebarStateReturn {
  isOpen: boolean
  isCollapsed: boolean
  mode: SidebarMode
  toggle: () => void
  open: () => void
  close: () => void
  collapse: () => void
  expand: () => void
}

/**
 * Hook for managing sidebar state with responsive behavior and localStorage persistence.
 *
 * Responsive behavior:
 * - Desktop (1024px+): Persistent sidebar, collapsible
 * - Tablet (768-1023px): Overlay sidebar with backdrop
 * - Mobile (<768px): Bottom drawer
 */
export function useSidebarState(): UseSidebarStateReturn {
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const isTablet = useMediaQuery('(min-width: 768px) and (max-width: 1023px)')
  // Mobile is the default when neither desktop nor tablet

  // Determine mode based on breakpoint
  const mode: SidebarMode = isDesktop ? 'persistent' : isTablet ? 'overlay' : 'drawer'

  // isOpen controls overlay/drawer visibility
  const [isOpen, setIsOpen] = useState(false)

  // isCollapsed controls desktop sidebar collapse state
  const [isCollapsed, setIsCollapsed] = useState(false)

  // Load collapsed state from localStorage on mount
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY)
      if (stored !== null) {
        setIsCollapsed(stored === 'true')
      }
    }
  }, [])

  // Persist collapsed state to localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, String(isCollapsed))
    }
  }, [isCollapsed])

  // Close overlay/drawer when switching to desktop mode
  useEffect(() => {
    if (isDesktop && isOpen) {
      setIsOpen(false)
    }
  }, [isDesktop, isOpen])

  const toggle = useCallback(() => {
    if (mode === 'persistent') {
      setIsCollapsed(prev => !prev)
    } else {
      setIsOpen(prev => !prev)
    }
  }, [mode])

  const open = useCallback(() => {
    if (mode === 'persistent') {
      setIsCollapsed(false)
    } else {
      setIsOpen(true)
    }
  }, [mode])

  const close = useCallback(() => {
    if (mode === 'persistent') {
      setIsCollapsed(true)
    } else {
      setIsOpen(false)
    }
  }, [mode])

  const collapse = useCallback(() => {
    setIsCollapsed(true)
  }, [])

  const expand = useCallback(() => {
    setIsCollapsed(false)
  }, [])

  return {
    isOpen,
    isCollapsed,
    mode,
    toggle,
    open,
    close,
    collapse,
    expand,
  }
}
