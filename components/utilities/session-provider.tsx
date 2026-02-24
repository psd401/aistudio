"use client";

import { SessionProvider } from "next-auth/react";

export default function AuthSessionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  // refetchOnWindowFocus disabled to prevent unnecessary session object churn on tab switch
  // (which would trigger useEffect deps that include `status`). A 5-minute background interval
  // preserves session expiry detection without requiring window focus events.
  return (
    <SessionProvider refetchOnWindowFocus={false} refetchInterval={5 * 60}>
      {children}
    </SessionProvider>
  );
}
