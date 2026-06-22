import StandardPageLayout from "@/components/layouts/standard-page-layout"

/**
 * Wraps the skill catalog pages in the standard app shell (NavbarNested sidebar +
 * padded content container), matching every other section (e.g. the Assistant
 * Architect). Without this, /skills rendered bare under (protected)/layout.tsx,
 * which only provides UserProvider.
 */
export default function SkillsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <StandardPageLayout>{children}</StandardPageLayout>
}
