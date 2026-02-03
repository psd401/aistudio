import StandardPageLayout from "@/components/layouts/standard-page-layout"

export default async function AssistantCatalogLayout({
  children
}: {
  children: React.ReactNode
}) {
  return <StandardPageLayout>{children}</StandardPageLayout>
}
