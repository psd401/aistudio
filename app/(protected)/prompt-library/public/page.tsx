import { Suspense } from "react"
import { PublicGalleryClient } from "./_components/public-gallery-client"
import { PublicGalleryHero } from "./_components/public-gallery-hero"
import { Skeleton } from "@/components/ui/skeleton"
import { generateGalleryStructuredData } from "./_components/seo-metadata"
import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Public Prompt Library - Discover Community Prompts",
  description: "Explore thousands of AI prompts created by the community. Find the perfect starting point for your next conversation.",
  openGraph: {
    title: "Public Prompt Library",
    description: "Explore thousands of AI prompts created by the community",
    type: "website"
  }
}

interface PageProps {
  searchParams: Promise<{
    q?: string
    tags?: string
    sort?: string
    page?: string
  }>
}

export default async function PublicPromptLibraryPage({
  searchParams
}: PageProps) {
  const params = await searchParams
  const query = params.q || ""
  const tags = params.tags ? params.tags.split(",") : []
  const sort = (params.sort as 'created' | 'usage' | 'views') || 'usage'
  const page = Number.parseInt(params.page || "1", 10)

  const structuredData = generateGalleryStructuredData()

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/20">
      {/* Structured Data for SEO */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

      {/* Hero Section */}
      <PublicGalleryHero />

      {/* Main Gallery */}
      <div className="container mx-auto px-4 py-8">
        <Suspense
          fallback={
            <div className="space-y-6">
              <Skeleton className="h-12 w-full" />
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {Array.from({ length: 9 }).map((_, i) => (
                  <Skeleton key={i} className="h-64 w-full" />
                ))}
              </div>
            </div>
          }
        >
          <PublicGalleryClient
            initialQuery={query}
            initialTags={tags}
            initialSort={sort}
            initialPage={page}
          />
        </Suspense>
      </div>
    </div>
  )
}
