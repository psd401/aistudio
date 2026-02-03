'use client'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Sparkles } from 'lucide-react'

interface SkillsPopoverProps {
  // Future: skills configuration
  disabled?: boolean
}

/**
 * Placeholder for Skills functionality.
 * Skills will allow users to select pre-built prompt templates and workflows.
 */
export function SkillsPopover({ disabled = true }: SkillsPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          disabled={disabled}
          title="Skills (coming soon)"
        >
          <Sparkles className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Skills</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-4" align="start">
        <div className="text-center">
          <Sparkles className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
          <h4 className="font-medium text-sm">Skills</h4>
          <p className="text-xs text-muted-foreground mt-1">
            Pre-built prompt templates and workflows. Coming soon!
          </p>
        </div>
      </PopoverContent>
    </Popover>
  )
}
