"use client"

import { useState } from "react"
import { FileUploadModal } from "./file-upload-modal"
import { RepositoryPicker } from "./repository-picker"

export interface RepositorySourcePickerProps {
  repositoryId?: number
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: (repositoryId: number) => void
}

/**
 * Reusable select/create-then-ingest flow. When a repository is already known,
 * it opens the source picker directly; otherwise it first asks for a private
 * manageable destination.
 */
export function RepositorySourcePicker({
  repositoryId,
  open,
  onOpenChange,
  onSuccess,
}: RepositorySourcePickerProps) {
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<
    number | null
  >(null)
  const destinationRepositoryId = repositoryId ?? selectedRepositoryId

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && repositoryId === undefined) {
      setSelectedRepositoryId(null)
    }
    onOpenChange(nextOpen)
  }

  if (destinationRepositoryId === null) {
    return (
      <RepositoryPicker
        open={open}
        onOpenChange={handleOpenChange}
        selectedRepositoryIds={[]}
        onSelectionChange={(ids) => {
          const selected = ids[0]
          if (selected !== undefined) setSelectedRepositoryId(selected)
        }}
        selectionMode="single"
        manageableOnly
        closeOnSelect={false}
        title="Choose a destination"
        description="Select a repository you manage, or create a new private repository."
      />
    )
  }

  return (
    <FileUploadModal
      repositoryId={destinationRepositoryId}
      open={open}
      onOpenChange={handleOpenChange}
      onSuccess={() => onSuccess(destinationRepositoryId)}
    />
  )
}
