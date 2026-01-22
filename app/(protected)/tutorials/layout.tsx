import { DashboardLayout } from "@/components/layouts/dashboard-layout"

export default function TutorialsLayout({
  children
}: {
  children: React.ReactNode
}) {
  return <DashboardLayout>{children}</DashboardLayout>
}
