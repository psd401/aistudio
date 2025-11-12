'use client'

import { FormEvent, KeyboardEvent } from 'react'
import { motion } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Send, Paperclip, Square } from 'lucide-react'

interface NexusComposerProps {
  input: string
  isLoading: boolean
  onInputChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onSubmit: (e: FormEvent<HTMLFormElement>) => void
  onStop?: () => void
  disabled?: boolean
  placeholder?: string
}

export function NexusComposer({
  input,
  isLoading,
  onInputChange,
  onSubmit,
  onStop,
  disabled,
  placeholder = "Type your message... (⌘+Enter to send)"
}: NexusComposerProps) {
  
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Submit on Cmd/Ctrl+Enter
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      if (!disabled && !isLoading && input.trim()) {
        const form = e.currentTarget.form
        if (form) {
          form.requestSubmit()
        }
      }
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex w-full">
      <div className="flex w-full items-end gap-3 rounded-2xl border border-border bg-background p-3 shadow-sm transition-all focus-within:border-primary focus-within:shadow-md">
        {/* Attachment Button */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 flex-shrink-0 rounded-full"
          disabled={isLoading || disabled}
        >
          <Paperclip size={16} />
        </Button>

        {/* Text Input */}
        <div className="flex-1">
          <Textarea
            value={input}
            onChange={onInputChange}
            onKeyDown={handleKeyDown}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- Intentional: chat input is primary page purpose
            autoFocus
            placeholder={
              isLoading
                ? "AI is responding..."
                : placeholder
            }
            disabled={isLoading || disabled}
            className="min-h-[20px] w-full resize-none border-0 bg-white dark:bg-gray-900 p-0 text-base placeholder:text-muted-foreground focus-visible:ring-0"
            rows={1}
          />
        </div>

        {/* Send/Cancel Button */}
        {isLoading && onStop ? (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onStop}
              className="h-8 w-8 flex-shrink-0 rounded-full bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              <Square size={12} />
            </Button>
          </motion.div>
        ) : (
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            exit={{ scale: 0 }}
          >
            <Button
              type="submit"
              size="sm"
              disabled={disabled || isLoading || !input.trim()}
              className="h-8 w-8 flex-shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              <Send size={12} />
            </Button>
          </motion.div>
        )}
      </div>
    </form>
  )
}