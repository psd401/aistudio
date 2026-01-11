import { DashboardLayout as DashboardLayoutComponent } from "@/components/layouts/dashboard-layout"

export default function DashboardLayout({
  children
}: {
  children: React.ReactNode
}) {
  return <DashboardLayoutComponent>{children}</DashboardLayoutComponent>
} 