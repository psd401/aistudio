"use client"

import { RepositoryPicker } from "@/components/features/repositories/repository-picker"

interface RepositoryBrowserProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedIds: number[]
  onSelectionChange: (ids: number[]) => void
}

/**
 * Assistant Architect compatibility wrapper around the universal repository
 * picker. Keeping this small adapter avoids a second repository catalog UI
 * while existing prompt-editor call sites retain their established API.
 */
export function RepositoryBrowser({
  open,
  onOpenChange,
  selectedIds,
  onSelectionChange,
}: RepositoryBrowserProps) {
  return (
    <RepositoryPicker
      open={open}
      onOpenChange={onOpenChange}
      selectedRepositoryIds={selectedIds}
      onSelectionChange={onSelectionChange}
      selectionMode="multiple"
      allowCreate
      closeOnSelect={false}
      title="Choose knowledge repositories"
      description="Select accessible repositories or create a private repository for this prompt."
    />
  )
}
