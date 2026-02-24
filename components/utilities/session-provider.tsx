"use client";

import { SessionProvider } from "next-auth/react";

export default function AuthSessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // NOTE: This affects the entire app (wraps RootLayout). The trade-off is accepted because:
  // 1. API routes enforce auth independently (JWT validation on each request)
  // 2. Stale session objects were causing Nexus useEffect dep instability (see #811)
  // 3. The 5-minute poll provides a reasonable expiry detection fallback
  //
  // refetchInterval added to compensate: polls every 5 min to detect session expiry
  // (previously no background polling existed; refetchOnWindowFocus covered this).
  // Note: each open tab generates one /api/auth/session request per interval.
  return (
    <SessionProvider refetchOnWindowFocus={false} refetchInterval={5 * 60}>
      {children}
    </SessionProvider>
  );
}
