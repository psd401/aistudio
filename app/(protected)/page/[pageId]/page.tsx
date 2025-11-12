import { notFound } from "next/navigation"
import { executeSQL } from "@/lib/db/data-api-adapter"
import { Suspense } from "react"
import Image from "next/image"
import Link from "next/link"
import logger from "@/lib/logger"
import { extractRDSString, ensureRDSNumber, toReactKey, ensureRDSString } from "@/lib/type-helpers"
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
    const pageItemSql = 'SELECT * FROM navigation_items WHERE link = :pageLink AND type = :type::navigation_type';
    const pageItemResult = await executeSQL(pageItemSql, [
      { name: 'pageLink', value: { stringValue: pageLink } },
      { name: 'type', value: { stringValue: 'page' } }
    ]);
    
    const pageItem = pageItemResult[0];
    if (!pageItem || pageItem.type !== "page") {
      notFound()
    }

  // Fetch all child links/tools of this page
  const childItemsSql = `
    SELECT * FROM navigation_items 
    WHERE parent_id = :parentId 
    AND type = 'link'::navigation_type 
    AND is_active = true
    ORDER BY position ASC
  `;
  const childItems = await executeSQL(childItemsSql, [
    { name: 'parentId', value: { longValue: ensureRDSNumber(pageItem.id) } }
  ]);

  // Helper to extract toolId from a link like /tools/assistant-architect/{toolId}
  function extractAssistantId(link: unknown): number | null {
    const linkStr = extractRDSString(link)
    if (!linkStr) return null
    const match = linkStr.match(/\/tools\/assistant-architect\/(\d+)/)
    return match ? Number.parseInt(match[1], 10) : null
  }

  // For each child, try to extract assistant/tool id from the link
  const childAssistantIds = childItems
    .map((child) => extractAssistantId(child.link))
    .filter((id): id is number => id !== null && !Number.isNaN(id))

  let assistants: Record<number, SelectAssistantArchitect> = {}
  if (childAssistantIds.length > 0) {
    // Build the IN clause for SQL with integer IDs
    const placeholders = childAssistantIds.map((_, i) => `:id${i}`).join(', ');
    const assistantsSql = `SELECT * FROM assistant_architects WHERE id IN (${placeholders})`;
    const assistantParams = childAssistantIds.map((id, i) => ({
      name: `id${i}`,
      value: { longValue: id }
    }));
    
    const assistantRows = await executeSQL(assistantsSql, assistantParams);
    assistants = Object.fromEntries(assistantRows.map((a) => [ensureRDSNumber(a.id), a as unknown as SelectAssistantArchitect]))
  }

  return (
    <>
      <h1 className="text-3xl font-bold mb-4">{ensureRDSString(pageItem.label)}</h1>
      {pageItem.description && (
        <p className="mb-6 text-muted-foreground">{ensureRDSString(pageItem.description)}</p>
      )}
      <Suspense fallback={<div>Loading tools...</div>}>
        {childItems.length === 0 ? (
          <div className="text-muted-foreground text-center py-12">No tools assigned to this page.</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-6">
            {childItems.map((child) => {
              const assistantId = extractAssistantId(child.link)
              const assistant = assistantId ? assistants[assistantId] : null
              const href = extractRDSString(child.link) || "#"
              return (
                <Link
                  key={toReactKey(child.id)}
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
                        <span className={`i-lucide:${extractRDSString(child.icon) || 'file'}`} />
                      </span>
                    )}
                    <div className="ml-4">
                      <div className="font-semibold text-lg">
                        {assistant ? ensureRDSString(assistant.name) : ensureRDSString(child.label)}
                      </div>
                      <div className="text-muted-foreground text-sm mt-1">
                        {assistant ? extractRDSString(assistant.description) : extractRDSString(child.description)}
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