import { notFound } from "next/navigation"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq, inArray } from "drizzle-orm"
import { navigationItems, assistantArchitects } from "@/lib/db/schema"
import { Suspense } from "react"
import Image from "next/image"
import Link from "next/link"
import logger from "@/lib/logger"
import type { SelectAssistantArchitect } from "@/types/db-types"

interface PageProps {
  params: Promise<{ pageId: string }>
}

export default async function PublicPage({ params }: PageProps) {
  const { pageId } = await params

  try {
    // Construct the full link path from the pageId slug
    const pageLink = `/page/${pageId}`;

    // Fetch the page navigation item by link
    const [pageItem] = await executeQuery(
      (db) => db.select()
        .from(navigationItems)
        .where(eq(navigationItems.link, pageLink))
        .limit(1),
      "getPageByLink"
    );

    if (!pageItem || pageItem.type !== "page") {
      notFound()
    }

  // Fetch all child links/tools of this page
  const childItems = await executeQuery(
    (db) => db.select()
      .from(navigationItems)
      .where(eq(navigationItems.parentId, pageItem.id))
      .orderBy(navigationItems.position),
    "getChildNavigationItems"
  );

  // Helper to extract toolId from a link like /tools/assistant-architect/{toolId}
  function extractAssistantId(link: string | null): number | null {
    if (!link) return null
    const match = link.match(/\/tools\/assistant-architect\/(\d+)/)
    return match ? Number.parseInt(match[1], 10) : null
  }

  // For each child, try to extract assistant/tool id from the link
  const childAssistantIds = childItems
    .map((child) => extractAssistantId(child.link))
    .filter((id): id is number => id !== null && !Number.isNaN(id))

  let assistants: Record<number, SelectAssistantArchitect> = {}
  if (childAssistantIds.length > 0) {
    const assistantRows = await executeQuery(
      (db) => db.select()
        .from(assistantArchitects)
        .where(inArray(assistantArchitects.id, childAssistantIds)),
      "getAssistantArchitectsByIds"
    );

    assistants = Object.fromEntries(
      assistantRows.map((a) => [a.id, a as SelectAssistantArchitect])
    )
  }

  return (
    <>
      <h1 className="text-3xl font-bold mb-4">{pageItem.label}</h1>
      {pageItem.description && (
        <p className="mb-6 text-muted-foreground">{pageItem.description}</p>
      )}
      <Suspense fallback={<div>Loading tools...</div>}>
        {childItems.length === 0 ? (
          <div className="text-muted-foreground text-center py-12">No tools assigned to this page.</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
            {childItems.map((child) => {
              const assistantId = extractAssistantId(child.link)
              const assistant = assistantId ? assistants[assistantId] : null
              const href = child.link || "#"
              return (
                <Link
                  key={child.id}
                  href={href}
                  className="block rounded-lg border bg-card shadow-sm hover:shadow-md transition p-6 group focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <div className="flex items-start">
                    {assistant && assistant.imagePath ? (
                      <Image
                        src={`/assistant_logos/${assistant.imagePath}`}
                        alt={assistant.name}
                        width={64}
                        height={64}
                        className="w-16 h-16 min-w-[64px] min-h-[64px] rounded-lg object-cover flex-shrink-0"
                      />
                    ) : (
                      <span className="text-3xl text-muted-foreground block">
                        <span className={`i-lucide:${child.icon || 'file'}`} />
                      </span>
                    )}
                    <div className="ml-4">
                      <div className="font-semibold text-lg">
                        {assistant ? assistant.name : child.label}
                      </div>
                      <div className="text-muted-foreground text-sm mt-1">
                        {assistant ? assistant.description : child.description}
                      </div>
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </Suspense>
    </>
  )
  } catch (error) {
    logger.error('Error loading page:', error);
    notFound();
  }
} 