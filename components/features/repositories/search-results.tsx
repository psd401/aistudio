"use client"

import { SearchResult } from "@/lib/repositories/search-service"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { FileText, Hash } from "lucide-react"
import { cn } from "@/lib/utils"

interface SearchResultsProps {
  results: SearchResult[]
  query: string
  isLoading?: boolean
}

export function SearchResults({ results, query, isLoading }: SearchResultsProps) {
  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <Card key={i} className="animate-pulse">
            <CardHeader>
              <div className="h-4 bg-muted rounded w-1/3 mb-2" />
              <div className="h-3 bg-muted rounded w-1/4" />
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="h-3 bg-muted rounded" />
                <div className="h-3 bg-muted rounded w-5/6" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  if (results.length === 0) {
    return (
      <Card>
        <CardContent className="text-center py-8">
          <p className="text-muted-foreground">
            No results found for &quot;{query}&quot;
          </p>
          <p className="text-sm text-muted-foreground mt-2">
            Try different keywords or check your spelling
          </p>
        </CardContent>
      </Card>
    )
  }

  // Helper to highlight matching text (simple approach)
  const highlightText = (text: string, query: string) => {
    // Escape regex special characters to prevent ReDoS
    const escapedQuery = query.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')
    // eslint-disable-next-line security/detect-non-literal-regexp -- escapedQuery is sanitized via regex escape above
    const parts = text.split(new RegExp(`(${escapedQuery})`, 'gi'))
    return parts.map((part, i) =>
      part.toLowerCase() === query.toLowerCase() ?
        <mark key={`highlight-${i}-${part}`} className="bg-yellow-200 dark:bg-yellow-800">{part}</mark> :
        part
    )
  }

  // Truncate content to show context around matches
  const getSnippet = (content: string, maxLength: number = 200) => {
    if (content.length <= maxLength) return content
    
    // Try to find the query in the content
    const queryIndex = content.toLowerCase().indexOf(query.toLowerCase())
    if (queryIndex !== -1) {
      // Show context around the match
      const start = Math.max(0, queryIndex - 50)
      const end = Math.min(content.length, queryIndex + query.length + 150)
      const snippet = content.slice(start, end)
      return `${start > 0 ? '...' : ''}${snippet}${end < content.length ? '...' : ''}`
    }
    
    // Otherwise just truncate
    return content.slice(0, maxLength) + '...'
  }

  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">
        Found {results.length} result{results.length !== 1 ? 's' : ''}
      </div>

      {results.map((result, index) => (
        <Card 
          key={`${result.itemId}-${result.chunkId}-${index}`}
          className={cn(
            "transition-colors hover:bg-muted/50",
            result.similarity > 0.9 && "border-green-500/50",
            result.similarity > 0.8 && result.similarity <= 0.9 && "border-blue-500/50"
          )}
        >
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between">
              <div className="space-y-1">
                <CardTitle className="text-base flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  {result.itemName}
                </CardTitle>
                <CardDescription className="flex items-center gap-2">
                  <Hash className="h-3 w-3" />
                  Chunk {typeof result.chunkIndex === 'number' ? result.chunkIndex + 1 : 1}
                </CardDescription>
              </div>
              <Badge 
                variant={result.similarity > 0.9 ? "default" : result.similarity > 0.8 ? "secondary" : "outline"}
                className="ml-2"
              >
                {!Number.isNaN(result.similarity) ? `${(result.similarity * 100).toFixed(0)}% match` : 'Match'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm leading-relaxed">
              {highlightText(getSnippet(result.content), query)}
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}