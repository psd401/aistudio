'use client';

import { NavbarNested } from '@/components/navigation/navbar-nested';

interface DashboardLayoutProps {
  children: React.ReactNode;
}

/**
 * Dashboard-specific layout without global header.
 * Provides full-screen experience with sidebar navigation.
 */
export function DashboardLayout({ children }: DashboardLayoutProps) {
  return (
    <div className="flex min-h-screen">
      <NavbarNested fullHeight />
      <main className="flex-1 lg:pl-[68px]">{children}</main>
    </div>
  );
}
