'use client'

import React, { memo, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import { marked } from 'marked'
import { cn } from '@/lib/utils'
import type { Components } from 'react-markdown'

interface ParsedBlock {
  content: string
  type: 'code' | 'text' | 'heading' | 'list' | 'blockquote' | 'table' | 'other'
  language?: string
}

function parseMarkdownIntoBlocks(markdown: string): ParsedBlock[] {
  try {
    const tokens = marked.lexer(markdown)
    const blocks: ParsedBlock[] = []
    
    for (const token of tokens) {
      if (token.type === 'code') {
        blocks.push({
          content: token.raw,
          type: 'code',
          language: token.lang || undefined
        })
      } else if (token.type === 'heading') {
        blocks.push({
          content: token.raw,
          type: 'heading'
        })
      } else if (token.type === 'list') {
        blocks.push({
          content: token.raw,
          type: 'list'
        })
      } else if (token.type === 'blockquote') {
        blocks.push({
          content: token.raw,
          type: 'blockquote'
        })
      } else if (token.type === 'table') {
        blocks.push({
          content: token.raw,
          type: 'table'
        })
      } else if (token.raw && token.raw.trim()) {
        blocks.push({
          content: token.raw,
          type: token.type === 'paragraph' ? 'text' : 'other'
        })
      }
    }
    
    // Handle case where parsing fails or returns empty
    if (blocks.length === 0 && markdown.trim()) {
      blocks.push({
        content: markdown,
        type: 'text'
      })
    }
    
    return blocks
  } catch {
    // Fallback: treat entire content as a single text block
    return [{
      content: markdown,
      type: 'text'
    }]
  }
}

interface MemoizedMarkdownBlockProps {
  block: ParsedBlock
  components?: Components
  className?: string
  onCodeRender?: (language: string | undefined, code: string) => void
}

const MemoizedMarkdownBlock = memo(
  ({ block, components, className, onCodeRender }: MemoizedMarkdownBlockProps) => {
    // Notify parent when a code block is about to render
    React.useEffect(() => {
      if (block.type === 'code' && onCodeRender) {
        // Extract code content from the raw markdown
        const codeMatch = block.content.match(/```[\S\s]*?\n([\S\s]*?)```/)
        const code = codeMatch ? codeMatch[1] : block.content
        onCodeRender(block.language, code)
      }
    }, [block, onCodeRender])
    
    return (
      <div className={cn('markdown-block', `markdown-block-${block.type}`, className)}>
        <ReactMarkdown components={components}>
          {block.content}
        </ReactMarkdown>
      </div>
    )
  },
  (prevProps, nextProps) => {
    // Custom comparison: only re-render if content or components change
    return (
      prevProps.block.content === nextProps.block.content &&
      prevProps.block.type === nextProps.block.type &&
      prevProps.block.language === nextProps.block.language &&
      prevProps.components === nextProps.components &&
      prevProps.className === nextProps.className
    )
  }
)

MemoizedMarkdownBlock.displayName = 'MemoizedMarkdownBlock'

interface MemoizedMarkdownProps {
  content: string
  id: string
  components?: Components
  className?: string
  streamingBuffer?: StreamingBuffer
}

interface StreamingBuffer {
  enabled: boolean
  incompleteCodeFence?: string
  bufferedContent?: string
}

export const MemoizedMarkdown = memo(
  ({ 
    content, 
    id, 
    components, 
    className,
    streamingBuffer
  }: MemoizedMarkdownProps) => {
    // Process content with streaming buffer if enabled
    const processedContent = useMemo(() => {
      if (!streamingBuffer?.enabled) {
        return content
      }
      
      // Check for incomplete code blocks during streaming
      const lines = content.split('\n')
      let inCodeBlock = false
      let codeBlockStartIndex = -1
      const processedLines: string[] = []
      
      for (const [i, line] of lines.entries()) {
        
        // Check for code fence
        if (line.startsWith('```')) {
          if (!inCodeBlock) {
            // Starting a code block
            inCodeBlock = true
            codeBlockStartIndex = i
            processedLines.push(line)
          } else {
            // Ending a code block
            inCodeBlock = false
            codeBlockStartIndex = -1
            processedLines.push(line)
          }
        } else {
          processedLines.push(line)
        }
      }
      
      // If we're still in a code block at the end, show loading indicator
      if (inCodeBlock && codeBlockStartIndex >= 0) {
        // Remove the incomplete code block from processed content
        const beforeCodeBlock = processedLines.slice(0, codeBlockStartIndex).join('\n')
        
        // Return content before the incomplete block with loading indicator
        // Note: We don't mutate streamingBuffer here - that's an anti-pattern
        return beforeCodeBlock + '\n\n*[Loading code block...]*'
      }
      
      return processedLines.join('\n')
    }, [content, streamingBuffer?.enabled])
    
    // Parse markdown into blocks
    const blocks = useMemo(() => {
      return parseMarkdownIntoBlocks(processedContent)
    }, [processedContent])
    
    // Handler for code rendering
    const handleCodeRender = React.useCallback(() => {
      // This can be used for analytics or debugging
      if (process.env.NODE_ENV === 'development') {
        // Log code blocks being rendered in development
      }
    }, [])
    
    return (
      <div className={cn('memoized-markdown', className)}>
        {blocks.map((block, index) => (
          <MemoizedMarkdownBlock
            key={`${id}-block_${index}`}
            block={block}
            components={components}
            onCodeRender={handleCodeRender}
          />
        ))}
      </div>
    )
  },
  (prevProps, nextProps) => {
    // Only re-render if content, id, or streaming state changes
    return (
      prevProps.content === nextProps.content &&
      prevProps.id === nextProps.id &&
      prevProps.components === nextProps.components &&
      prevProps.className === nextProps.className &&
      prevProps.streamingBuffer?.enabled === nextProps.streamingBuffer?.enabled
    )
  }
)

MemoizedMarkdown.displayName = 'MemoizedMarkdown'

// Export utility function for external use
export { parseMarkdownIntoBlocks }