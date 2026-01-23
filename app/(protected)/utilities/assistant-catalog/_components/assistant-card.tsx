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
}

// Category colors matching the dashboard design
const CATEGORY_COLORS: Record<CatalogAssistant['category'], { bg: string; text: string; icon: string }> = {
  pedagogical: {
    bg: 'bg-[#6B9E78]/15',
    text: 'text-[#6B9E78]',
    icon: '#6B9E78'
  },
  operational: {
    bg: 'bg-[#7B68A6]/15',
    text: 'text-[#7B68A6]',
    icon: '#7B68A6'
  },
  communications: {
    bg: 'bg-[#E8927C]/15',
    text: 'text-[#E8927C]',
    icon: '#E8927C'
  },
  other: {
    bg: 'bg-[#1B365D]/10',
    text: 'text-[#1B365D]',
    icon: '#1B365D'
  }
}

const CATEGORY_LABELS: Record<CatalogAssistant['category'], string> = {
  pedagogical: 'Pedagogical',
  operational: 'Operational',
  communications: 'Communications',
  other: 'General'
}

function AssistantCardComponent({ assistant }: AssistantCardProps) {
  const router = useRouter()
  const { toggleFavorite, isFavorite } = useAssistantCatalogStore()
  const [isHovered, setIsHovered] = useState(false)

  const favorited = isFavorite(assistant.id)
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
        "hover:shadow-lg hover:-translate-y-0.5"
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
            <h3 className="font-semibold text-base line-clamp-1">{assistant.name}</h3>
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
