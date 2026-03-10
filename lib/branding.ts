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
 * Call once per request in a server component and pass to children as props.
 */
export async function getBrandingConfig(): Promise<BrandingConfig> {
  const branding = await Settings.getBranding()

  // Resolve S3 logo URL if needed
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
}
