'use client'

import type { SourceMessagePartComponent } from '@assistant-ui/react'
import { ExternalLink, Globe } from 'lucide-react'
import { isSafeUrl } from '@/lib/utils'

export const WebSearchSource: SourceMessagePartComponent = ({ url, title }) => {
  // Security: Only render http/https URLs to prevent XSS via javascript:, data:, etc.
  if (!isSafeUrl(url)) {
    return null
  }

  let domain = url
  try {
    domain = new URL(url).hostname.replace('www.', '')
  } catch { /* use raw url as fallback */ }

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/50
                 px-3 py-2 sm:py-1.5 text-xs text-blue-800 hover:bg-blue-100 hover:border-blue-300
                 transition-colors no-underline mr-2 mb-2 min-h-[44px] sm:min-h-0"
    >
      <Globe className="h-3.5 w-3.5 text-blue-600 flex-shrink-0" aria-hidden="true" />
      <span className="truncate max-w-[250px] font-medium">
        {title || domain}
      </span>
      <span className="text-blue-600 text-[10px] hidden sm:inline">
        {title ? domain : ''}
      </span>
      <ExternalLink className="h-3 w-3 text-blue-600 flex-shrink-0" aria-hidden="true" />
      <span className="sr-only">Opens in new tab</span>
    </a>
  )
}
