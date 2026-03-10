'use client'

import { createContext, useContext } from 'react'

export interface BrandingValues {
  orgName: string
  appName: string
  logoSrc: string
}

const BrandingContext = createContext<BrandingValues>({
  orgName: 'Your Organization',
  appName: 'AI Studio',
  logoSrc: '/logo.png',
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
