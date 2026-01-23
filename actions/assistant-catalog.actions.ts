"use server"

import { handleError, createSuccess, ErrorFactories } from "@/lib/error-utils"
import { ActionState } from "@/types"
import {
  createLogger,
  generateRequestId,
  startTimer
} from "@/lib/logger"
import { getServerSession } from "@/lib/auth/server-session"
import { executeQuery } from "@/lib/db/drizzle-client"
import { eq, desc } from "drizzle-orm"
import { assistantArchitects } from "@/lib/db/schema"

/**
 * Represents an assistant for display in the catalog
 */
export interface CatalogAssistant {
  id: number
  name: string
  description: string | null
  imagePath: string | null
  createdAt: Date
  // Derived category based on name/description keywords
  category: 'pedagogical' | 'operational' | 'communications' | 'other'
}

/**
 * Derives a category from assistant name and description using keyword matching
 * This is a temporary solution until a proper category field is added to the schema
 */
function deriveCategory(name: string, description: string | null): CatalogAssistant['category'] {
  const text = `${name} ${description || ''}`.toLowerCase()

  // Pedagogical/Educational keywords
  const pedagogicalKeywords = [
    'lesson', 'curriculum', 'assessment', 'rubric', 'learning', 'teaching',
    'student', 'classroom', 'educational', 'instruction', 'grade', 'course',
    'homework', 'quiz', 'test', 'exam', 'tutor', 'mentor', 'iep', 'special ed'
  ]

  // Operational/Administrative keywords
  const operationalKeywords = [
    'report', 'schedule', 'meeting', 'budget', 'policy', 'procedure',
    'admin', 'management', 'data', 'analysis', 'workflow', 'process',
    'documentation', 'compliance', 'audit', 'review'
  ]

  // Communications keywords
  const communicationsKeywords = [
    'email', 'message', 'newsletter', 'announcement', 'communication',
    'parent', 'family', 'outreach', 'letter', 'memo', 'notification',
    'social media', 'press', 'marketing', 'blog', 'article'
  ]

  if (pedagogicalKeywords.some(keyword => text.includes(keyword))) {
    return 'pedagogical'
  }

  if (operationalKeywords.some(keyword => text.includes(keyword))) {
    return 'operational'
  }

  if (communicationsKeywords.some(keyword => text.includes(keyword))) {
    return 'communications'
  }

  return 'other'
}

/**
 * Gets all approved assistant architects for the catalog
 * Shows all approved assistants - access control is handled at execution time
 */
export async function getAssistantCatalogAction(): Promise<
  ActionState<CatalogAssistant[]>
> {
  const requestId = generateRequestId()
  const timer = startTimer("getAssistantCatalog")
  const log = createLogger({ requestId, action: "getAssistantCatalog" })

  try {
    log.info("Action started: Getting assistant catalog")

    const session = await getServerSession()
    if (!session || !session.sub) {
      log.warn("Unauthorized catalog access attempt")
      throw ErrorFactories.authNoSession()
    }

    log.debug("User authenticated", { userId: session.sub })

    // Fetch all approved architects
    // Access control is handled at execution time, not catalog browsing
    const approvedArchitects = await executeQuery(
      (db) =>
        db
          .select({
            id: assistantArchitects.id,
            name: assistantArchitects.name,
            description: assistantArchitects.description,
            imagePath: assistantArchitects.imagePath,
            createdAt: assistantArchitects.createdAt
          })
          .from(assistantArchitects)
          .where(eq(assistantArchitects.status, "approved"))
          .orderBy(desc(assistantArchitects.createdAt)),
      "getApprovedArchitectsForCatalog"
    )

    // Transform to catalog format with derived categories
    const catalogAssistants: CatalogAssistant[] = approvedArchitects.map(architect => ({
      id: architect.id,
      name: architect.name,
      description: architect.description,
      imagePath: architect.imagePath,
      createdAt: architect.createdAt,
      category: deriveCategory(architect.name, architect.description)
    }))

    log.info("Assistant catalog retrieved successfully", { count: catalogAssistants.length })
    timer({ status: "success", count: catalogAssistants.length })

    return createSuccess(catalogAssistants, "Assistant catalog retrieved successfully")
  } catch (error) {
    timer({ status: "error" })
    return handleError(error, "Failed to get assistant catalog. Please try again.", {
      context: "getAssistantCatalog",
      requestId,
      operation: "getAssistantCatalog"
    })
  }
}
