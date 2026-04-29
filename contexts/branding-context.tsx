'use client'

import { createContext, useContext } from 'react'
import type { BrandingConfig } from '@/lib/branding'

export type BrandingValues = Pick<BrandingConfig, 'orgName' | 'appName' | 'logoSrc'> & {
  /** True when logoSrc is an external URL (S3 signed) rather than a local path */
  logoIsExternal: boolean
}

const BrandingContext = createContext<BrandingValues>({
  orgName: 'Your Organization',
  appName: 'AI Studio',
  logoSrc: '/logo.png',
  logoIsExternal: false,
})

export function BrandingProvider({
  children,
  value,
}: {
  children: React.ReactNode
  value: BrandingValues
}) {
  return (
    <BrandingContext.Provider value={value}>
      {children}
    </BrandingContext.Provider>
  )
}

export function useBranding() {
  return useContext(BrandingContext)
}
