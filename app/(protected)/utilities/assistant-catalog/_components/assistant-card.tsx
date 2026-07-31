"use client"

import { memo, useState, useCallback } from "react"
import { useRouter } from "next/navigation"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Star, MessageCircle, Sparkles } from "lucide-react"
import { cn } from "@/lib/utils"
import { useAssistantCatalogStore } from "@/lib/stores/assistant-catalog-store"
import type { CatalogAssistant } from "@/actions/assistant-catalog.actions"

interface AssistantCardProps {
  assistant: CatalogAssistant
  isHydrated?: boolean
}

/**
 * Category colours, on Meridian tokens.
 *
 * These are NOT decoration — they encode the assistant's category, so unlike
 * the dashboard's old four-colour accent rainbow (deleted outright) the
 * differentiation is worth keeping. What changed is where the colours come
 * from: the previous hexes (#6B9E78 / #7B68A6 / #E8927C) were copied from the
 * dashboard design that no longer exists, so they matched nothing.
 *
 * Violet is deliberately absent. In Meridian it means AI-agent presence and
 * nothing else, so it cannot be spent on a category.
 */
const CATEGORY_COLORS: Record<CatalogAssistant['category'], { bg: string; text: string; icon: string }> = {
  pedagogical: {
    bg: 'bg-[var(--mer-human-you)]/12',
    text: 'text-[var(--mer-human-you)]',
    icon: 'var(--mer-human-you)'
  },
  operational: {
    bg: 'bg-[var(--mer-brand-mid)]/12',
    text: 'text-[var(--mer-brand-mid)]',
    icon: 'var(--mer-brand-mid)'
  },
  communications: {
    bg: 'bg-[var(--mer-human-other-1)]/12',
    text: 'text-[var(--mer-human-other-1)]',
    icon: 'var(--mer-human-other-1)'
  },
  other: {
    bg: 'bg-[var(--mer-brand-tint)]',
    text: 'text-[var(--mer-brand)]',
    icon: 'var(--mer-brand)'
  }
}

const CATEGORY_LABELS: Record<CatalogAssistant['category'], string> = {
  pedagogical: 'Pedagogical',
  operational: 'Operational',
  communications: 'Communications',
  other: 'General'
}

function AssistantCardComponent({ assistant, isHydrated = false }: AssistantCardProps) {
  const router = useRouter()
  const { toggleFavorite, isFavorite } = useAssistantCatalogStore()
  const [isHovered, setIsHovered] = useState(false)

  // Only check favorites after hydration to avoid SSR mismatch
  const favorited = isHydrated && isFavorite(assistant.id)
  const colors = CATEGORY_COLORS[assistant.category]

  const handleLaunch = useCallback(() => {
    // Navigate to the assistant execution page
    router.push(`/tools/assistant-architect/${assistant.id}`)
  }, [router, assistant.id])

  const handleToggleFavorite = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    toggleFavorite(assistant.id)
  }, [toggleFavorite, assistant.id])

  // Truncate description to ~100 characters
  const truncatedDescription = assistant.description
    ? assistant.description.length > 100
      ? `${assistant.description.slice(0, 100).trim()}...`
      : assistant.description
    : 'No description available'

  return (
    <Card
      className={cn(
        "group relative flex flex-col transition-all duration-200",
        "hover:border-[var(--mer-ink-muted)]"
      )}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Favorite Toggle */}
      <button
        onClick={handleToggleFavorite}
        className={cn(
          "absolute right-2 top-2 z-10 p-2 rounded-full transition-all",
          "hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
          isHovered || favorited ? "opacity-100" : "opacity-0"
        )}
        aria-label={favorited ? "Remove from favorites" : "Add to favorites"}
        aria-pressed={favorited}
      >
        <Star
          className={cn(
            "h-4 w-4 transition-colors",
            favorited ? "fill-yellow-400 text-yellow-400" : "text-muted-foreground"
          )}
        />
      </button>

      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          {/* Icon */}
          <div
            className={cn(
              "flex h-12 w-12 items-center justify-center rounded-xl flex-shrink-0",
              colors.bg
            )}
          >
            <Sparkles className="h-6 w-6" style={{ color: colors.icon }} />
          </div>

          <div className="flex-1 min-w-0 pr-8">
            <h3 className="font-semibold text-base">{assistant.name}</h3>
            <Badge
              variant="secondary"
              className={cn("mt-1 text-xs", colors.bg, colors.text)}
            >
              {CATEGORY_LABELS[assistant.category]}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pb-3 flex-1">
        <p className="text-sm text-muted-foreground line-clamp-3">
          {truncatedDescription}
        </p>
      </CardContent>

      <CardFooter className="pt-0">
        <Button className="w-full" onClick={handleLaunch}>
          <MessageCircle className="mr-2 h-4 w-4" />
          Launch Assistant
        </Button>
      </CardFooter>
    </Card>
  )
}

// Memoize to prevent unnecessary re-renders in large lists
export const AssistantCard = memo(AssistantCardComponent)
