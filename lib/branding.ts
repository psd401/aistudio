import { cache } from 'react'
import { Settings } from '@/lib/settings-manager'
import { getBrandingLogoUrlAction } from '@/actions/db/settings-actions'

export interface BrandingConfig {
  orgName: string
  appName: string
  primaryColor: string
  logoSrc: string
  supportUrl: string
}

/**
 * Server-only utility that fetches branding settings and resolves the logo URL.
 * Memoized per request via React.cache() — safe to call multiple times in the
 * same server render (e.g., generateMetadata + RootLayout) without double DB reads.
 * Falls back to safe defaults if the settings database is unavailable.
 */
export const getBrandingConfig = cache(async (): Promise<BrandingConfig> => {
  try {
    const branding = await Settings.getBranding()

    // Resolve S3 logo URL if needed; requires an active session — silently
    // falls back to /logo.png on unauthenticated routes (public pages).
    const logoSrc = branding.isLogoS3Key
      ? (await getBrandingLogoUrlAction()).data ?? '/logo.png'
      : branding.logoPath

    return {
      orgName: branding.orgName,
      appName: branding.appName,
      primaryColor: branding.primaryColor,
      logoSrc,
      supportUrl: branding.supportUrl,
    }
  } catch {
    // Return safe defaults so the app remains functional if settings DB is unavailable
    return {
      orgName: 'Your Organization',
      appName: 'AI Studio',
      primaryColor: '#1B365D',
      logoSrc: '/logo.png',
      supportUrl: '',
    }
  }
})
