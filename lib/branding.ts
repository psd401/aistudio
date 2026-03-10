import { cache } from 'react'
import { Settings } from '@/lib/settings-manager'
import { getDocumentSignedUrl } from '@/lib/aws/s3-client'

export interface BrandingConfig {
  orgName: string
  appName: string
  primaryColor: string
  logoSrc: string
  supportUrl: string
  appUrl: string
}

/**
 * Server-only utility that fetches branding settings and resolves the logo URL.
 * Memoized per request via React.cache() — safe to call multiple times in the
 * same server render (e.g., generateMetadata + RootLayout) without double DB reads.
 * Falls back to safe defaults if the settings database is unavailable.
 *
 * Note: Calls getDocumentSignedUrl() directly (no session required) so that
 * S3-hosted logos resolve correctly on unauthenticated routes (landing page, etc.).
 */
export const getBrandingConfig = cache(async (): Promise<BrandingConfig> => {
  try {
    const branding = await Settings.getBranding()

    // Resolve logo URL — use S3 signed URL directly (no session required),
    // unlike getBrandingLogoUrlAction() which is session-gated.
    let logoSrc = branding.logoPath
    if (branding.isLogoS3Key) {
      try {
        logoSrc = await getDocumentSignedUrl({ key: branding.logoPath, expiresIn: 3600 })
      } catch {
        logoSrc = '/logo.png'
      }
    }

    return {
      orgName: branding.orgName,
      appName: branding.appName,
      primaryColor: branding.primaryColor,
      logoSrc,
      supportUrl: branding.supportUrl,
      appUrl: branding.appUrl,
    }
  } catch {
    // Return safe defaults so the app remains functional if settings DB is unavailable
    return {
      orgName: 'Your Organization',
      appName: 'AI Studio',
      primaryColor: '#1B365D',
      logoSrc: '/logo.png',
      supportUrl: '',
      appUrl: '',
    }
  }
})
