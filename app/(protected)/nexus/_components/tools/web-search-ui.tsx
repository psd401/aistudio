'use client'

import { makeAssistantToolUI } from '@assistant-ui/react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ExternalLink, Globe, Clock } from 'lucide-react'
import { isSafeUrl } from '@/lib/utils'

interface WebSearchArgs {
  query: string
  maxResults?: number
}

interface WebSearchResult {
  query: string
  results: Array<{
    title: string
    url: string
    snippet: string
    source: string
    publishedDate?: string
  }>
  searchTime: number
  totalResults: number
}

export const WebSearchUI = makeAssistantToolUI<WebSearchArgs, WebSearchResult>({
  toolName: 'webSearch',
  render: ({ args, result }) => {
    if (!result) {
      // Loading state
      return (
        <Card className="border-blue-200 bg-blue-50/50">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-blue-600 animate-pulse" />
              <CardTitle className="text-sm text-blue-900">Searching the web...</CardTitle>
            </div>
            <CardDescription className="text-xs">
              Looking for: &ldquo;{args.query}&rdquo;
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="space-y-1">
                  <div className="h-4 bg-blue-100 rounded animate-pulse" />
                  <div className="h-3 bg-blue-100 rounded w-3/4 animate-pulse" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )
    }

    return (
      <Card className="border-blue-200 bg-blue-50/50">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Globe className="h-4 w-4 text-blue-600" />
              <CardTitle className="text-sm text-blue-900">Web Search Results</CardTitle>
            </div>
            <Badge variant="secondary" className="text-xs">
              {result.totalResults.toLocaleString()} results
            </Badge>
          </div>
          <CardDescription className="text-xs">
            <div className="flex items-center gap-4">
              <span>Query: &ldquo;{result.query}&rdquo;</span>
              <div className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                <span>{result.searchTime}ms</span>
              </div>
            </div>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {result.results.map((item, index) => {
            // Security: Only render http/https URLs to prevent XSS
            if (!isSafeUrl(item.url)) {
              return null
            }

            return (
              <div key={index} className="space-y-1">
                <div className="flex items-start justify-between gap-2">
                  <h4 className="text-sm font-medium text-blue-900 leading-tight">
                    {item.title}
                  </h4>
                  <ExternalLink className="h-3 w-3 text-blue-600 flex-shrink-0 mt-0.5" />
                </div>
                <div className="flex items-center gap-2 text-xs text-blue-700">
                  <span className="font-medium">{item.source}</span>
                  {item.publishedDate && (
                    <>
                      <span>•</span>
                      <span>{new Date(item.publishedDate).toLocaleDateString()}</span>
                    </>
                  )}
                </div>
                <p className="text-xs text-blue-800 leading-relaxed">
                  {item.snippet}
                </p>
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-blue-600 hover:text-blue-800 hover:underline break-all"
                >
                  {item.url}
                </a>
              </div>
            )
          })}
        </CardContent>
      </Card>
    )
  }
})