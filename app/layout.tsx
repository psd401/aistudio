import '@/app/globals.css';
import { Toaster } from 'sonner';
import AuthSessionProvider from "@/components/utilities/session-provider"
import { NotificationProvider } from "@/contexts/notification-context";
import { ErrorCaptureInit } from "@/components/utilities/error-capture-init";
import { fontSans } from "@/lib/fonts"
import { cn } from "@/lib/utils"

// Environment validation is handled server-side only
// Client-side validation would expose sensitive environment variable names

export const metadata = {
  title: 'AI Studio',
  description: 'Next-gen AI for education',
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head />
      <body
        className={cn(
          "min-h-screen bg-background font-sans antialiased",
          fontSans.variable
        )}
        suppressHydrationWarning
      >
        <AuthSessionProvider>
          <NotificationProvider>
            <ErrorCaptureInit />
            {children}
            <Toaster />
          </NotificationProvider>
        </AuthSessionProvider>
      </body>
    </html>
  )
}
