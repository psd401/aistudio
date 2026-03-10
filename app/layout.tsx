import '@/app/globals.css';
import { Toaster } from 'sonner';
import AuthSessionProvider from "@/components/utilities/session-provider"
import { NotificationProvider } from "@/contexts/notification-context";
import { BrandingProvider } from "@/contexts/branding-context";
import { ErrorCaptureInit } from "@/components/utilities/error-capture-init";
import { fontSans } from "@/lib/fonts"
import { cn } from "@/lib/utils"
import { getBrandingConfig } from "@/lib/branding"
import type { Metadata } from "next"

// Environment validation is handled server-side only
// Client-side validation would expose sensitive environment variable names

export async function generateMetadata(): Promise<Metadata> {
  const branding = await getBrandingConfig()
  return {
    title: branding.appName,
    description: `${branding.orgName} - ${branding.appName}`,
  }
}

export default async function RootLayout({
  children
}: {
  children: React.ReactNode
}) {
  const branding = await getBrandingConfig()

  return (
    <html
      lang="en"
      suppressHydrationWarning
      style={{ '--brand-primary': branding.primaryColor } as React.CSSProperties}
    >
      <head />
      <body
        className={cn(
          "min-h-screen bg-background font-sans antialiased",
          fontSans.variable
        )}
        suppressHydrationWarning
      >
        <AuthSessionProvider>
          <BrandingProvider value={{
            orgName: branding.orgName,
            appName: branding.appName,
            logoSrc: branding.logoSrc,
          }}>
            <NotificationProvider>
              <ErrorCaptureInit />
              {children}
              <Toaster />
            </NotificationProvider>
          </BrandingProvider>
        </AuthSessionProvider>
      </body>
    </html>
  )
}
