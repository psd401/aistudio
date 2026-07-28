"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import {
  extractImportCandidates,
  saveImportedMemories,
} from "@/actions/nexus/memory-import.actions"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { createLogger } from "@/lib/client-logger"
import type { NexusMemoryCategory } from "@/lib/db/schema"
import {
  MEMORY_IMPORT_VENDOR_GUIDES,
} from "@/lib/nexus/memory/import-prompts"
import {
  MAX_MEMORY_IMPORT_CHARS,
  MAX_MEMORY_IMPORT_SAVE_BATCH_CANDIDATES,
  MAX_NEXUS_MEMORY_CONTENT_CHARS,
} from "@/lib/nexus/memory/memory-constants"
import {
  MEMORY_IMPORT_VENDORS,
  type MemoryImportCandidate,
  type MemoryImportVendor,
} from "@/lib/nexus/memory/memory-import-schemas"

const log = createLogger({ component: "MemoryImportDialog" })

const MEMORY_CATEGORIES: ReadonlyArray<{
  value: NexusMemoryCategory
  label: string
}> = [
  { value: "profile", label: "Profile" },
  { value: "preference", label: "Preference" },
  { value: "context", label: "Context" },
]

interface CandidateDraft extends MemoryImportCandidate {
  id: string
  selected: boolean
}

interface SaveProgress {
  completed: number
  total: number
}

interface SelectedCandidate {
  candidate: CandidateDraft
  draftIndex: number
}

interface BatchedSaveOutcome {
  successful: number
  failedDraftIndexes: Set<number>
  requestFailureMessage: string | null
}

function candidateDrafts(
  candidates: readonly MemoryImportCandidate[],
): CandidateDraft[] {
  return candidates.map((candidate, index) => ({
    ...candidate,
    id: `memory-import-candidate-${index}`,
    selected: true,
  }))
}

async function saveCandidateBatches(
  vendor: MemoryImportVendor,
  selected: SelectedCandidate[],
  onProgress: (progress: SaveProgress) => void,
): Promise<BatchedSaveOutcome> {
  let successful = 0
  let requestFailureMessage: string | null = null
  const failedDraftIndexes = new Set<number>()

  for (
    let offset = 0;
    offset < selected.length;
    offset += MAX_MEMORY_IMPORT_SAVE_BATCH_CANDIDATES
  ) {
    const batch = selected.slice(
      offset,
      offset + MAX_MEMORY_IMPORT_SAVE_BATCH_CANDIDATES,
    )
    const result = await saveImportedMemories({
      vendor,
      candidates: batch.map(({ candidate }) => ({
        content: candidate.content,
        category: candidate.category,
      })),
    })
    if (!result.isSuccess) {
      requestFailureMessage = result.message
      for (const { draftIndex } of selected.slice(offset)) {
        failedDraftIndexes.add(draftIndex)
      }
      break
    }

    successful += result.data.successful
    for (const item of result.data.results) {
      if (item.status !== "failed") continue
      const draftIndex = batch[item.index]?.draftIndex
      if (draftIndex !== undefined) {
        failedDraftIndexes.add(draftIndex)
      }
    }
    onProgress({
      completed: Math.min(offset + batch.length, selected.length),
      total: selected.length,
    })
  }

  return {
    successful,
    failedDraftIndexes,
    requestFailureMessage,
  }
}

function ImportSourceStep({
  vendor,
  pastedText,
  error,
  isExtracting,
  onVendorChange,
  onPastedTextChange,
  onExtract,
}: {
  vendor: MemoryImportVendor
  pastedText: string
  error: string | null
  isExtracting: boolean
  onVendorChange: (vendor: MemoryImportVendor) => void
  onPastedTextChange: (value: string) => void
  onExtract: () => void
}) {
  const guide = MEMORY_IMPORT_VENDOR_GUIDES[vendor]

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(guide.exportPrompt)
      toast.success("Export prompt copied")
    } catch (copyError) {
      log.error("Copying the memory export prompt failed", {
        vendor,
        error:
          copyError instanceof Error
            ? copyError.message
            : String(copyError),
      })
      toast.error("Failed to copy the export prompt")
    }
  }

  return (
    <>
      <div className="space-y-2">
        <label htmlFor="memory-import-vendor" className="text-sm font-medium">
          Import from
        </label>
        <Select
          value={vendor}
          disabled={isExtracting}
          onValueChange={(value) =>
            onVendorChange(value as MemoryImportVendor)
          }
        >
          <SelectTrigger
            id="memory-import-vendor"
            data-testid="memory-import-vendor"
            className="w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MEMORY_IMPORT_VENDORS.map((option) => (
              <SelectItem key={option} value={option}>
                {MEMORY_IMPORT_VENDOR_GUIDES[option].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Get your memory list</p>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          {guide.instructions.map((instruction) => (
            <li key={instruction}>{instruction}</li>
          ))}
        </ol>
        <div className="rounded-md border bg-muted/40 p-3">
          <p className="whitespace-pre-wrap text-sm">
            {guide.exportPrompt}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            data-testid="memory-import-copy-prompt"
            disabled={isExtracting}
            onClick={() => void handleCopyPrompt()}
          >
            Copy prompt
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <label htmlFor="memory-import-paste" className="text-sm font-medium">
          Paste the response
        </label>
        <Textarea
          id="memory-import-paste"
          data-testid="memory-import-paste"
          className="min-h-40"
          value={pastedText}
          maxLength={MAX_MEMORY_IMPORT_CHARS}
          disabled={isExtracting}
          placeholder="Paste the memory list here. Nothing is saved until you review and confirm it."
          onChange={(event) => onPastedTextChange(event.target.value)}
        />
        <p className="text-right text-xs text-muted-foreground">
          {pastedText.length.toLocaleString()}/
          {MAX_MEMORY_IMPORT_CHARS.toLocaleString()}
        </p>
      </div>

      {error && (
        <div
          role="alert"
          data-testid="memory-import-error"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      <DialogFooter>
        <Button
          type="button"
          data-testid="memory-import-extract"
          disabled={!pastedText.trim() || isExtracting}
          onClick={onExtract}
        >
          {isExtracting && (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          )}
          Find memories
        </Button>
      </DialogFooter>
    </>
  )
}

function ImportReviewStep({
  candidates,
  isSaving,
  saveProgress,
  onCandidatesChange,
  onBack,
  onSave,
}: {
  candidates: CandidateDraft[]
  isSaving: boolean
  saveProgress: SaveProgress | null
  onCandidatesChange: (candidates: CandidateDraft[]) => void
  onBack: () => void
  onSave: () => void
}) {
  const selectedCount = candidates.filter(
    (candidate) => candidate.selected,
  ).length
  const updateCandidate = (
    id: string,
    update: Partial<
      Pick<CandidateDraft, "selected" | "content" | "category">
    >,
  ) => {
    onCandidatesChange(
      candidates.map((candidate) =>
        candidate.id === id ? { ...candidate, ...update } : candidate,
      ),
    )
  }

  return (
    <>
      <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
        Review, edit, and deselect candidates before saving. No memory has
        been written yet.
      </div>
      {candidates.length === 0 ? (
        <div
          data-testid="memory-import-empty"
          className="rounded-md border p-6 text-center text-sm text-muted-foreground"
        >
          No durable memories were found in the pasted response.
        </div>
      ) : (
        <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
          {candidates.map((candidate, index) => (
            <div
              key={candidate.id}
              data-testid="memory-import-candidate"
              className="space-y-3 rounded-md border p-3"
            >
              <div className="flex items-start gap-3">
                <Checkbox
                  checked={candidate.selected}
                  disabled={isSaving}
                  data-testid={`memory-import-candidate-select-${index}`}
                  aria-label={`Import candidate ${index + 1}`}
                  className="mt-2"
                  onCheckedChange={(checked) =>
                    updateCandidate(candidate.id, {
                      selected: checked === true,
                    })
                  }
                />
                <Textarea
                  value={candidate.content}
                  maxLength={MAX_NEXUS_MEMORY_CONTENT_CHARS}
                  disabled={isSaving}
                  data-testid={`memory-import-candidate-content-${index}`}
                  aria-label={`Memory candidate ${index + 1} content`}
                  onChange={(event) =>
                    updateCandidate(candidate.id, {
                      content: event.target.value,
                    })
                  }
                />
              </div>
              <Select
                value={candidate.category}
                disabled={isSaving}
                onValueChange={(value) =>
                  updateCandidate(candidate.id, {
                    category: value as NexusMemoryCategory,
                  })
                }
              >
                <SelectTrigger
                  className="w-full sm:w-44"
                  data-testid={`memory-import-candidate-category-${index}`}
                  aria-label={`Memory candidate ${index + 1} category`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MEMORY_CATEGORIES.map((category) => (
                    <SelectItem
                      key={category.value}
                      value={category.value}
                    >
                      {category.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ))}
        </div>
      )}
      <DialogFooter className="gap-2 sm:gap-0">
        <Button
          type="button"
          variant="outline"
          disabled={isSaving}
          onClick={onBack}
        >
          Back
        </Button>
        <Button
          type="button"
          data-testid="memory-import-save"
          disabled={
            selectedCount === 0 ||
            candidates.some(
              (candidate) =>
                candidate.selected && !candidate.content.trim(),
            ) ||
            isSaving
          }
          onClick={onSave}
        >
          {isSaving && (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          )}
          {saveProgress
            ? `Importing ${saveProgress.completed}/${saveProgress.total}`
            : `Import ${selectedCount} ${
                selectedCount === 1 ? "memory" : "memories"
              }`}
        </Button>
      </DialogFooter>
    </>
  )
}

function useMemoryImportDialog({
  onOpenChange,
  onImported,
}: {
  onOpenChange: (open: boolean) => void
  onImported: () => Promise<void>
}) {
  const [vendor, setVendor] =
    useState<MemoryImportVendor>("chatgpt")
  const [pastedText, setPastedText] = useState("")
  const [candidates, setCandidates] = useState<CandidateDraft[]>([])
  const [step, setStep] = useState<"source" | "review">("source")
  const [error, setError] = useState<string | null>(null)
  const [isExtracting, setIsExtracting] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [saveProgress, setSaveProgress] =
    useState<SaveProgress | null>(null)
  const isBusy = isExtracting || isSaving

  const reset = () => {
    setVendor("chatgpt")
    setPastedText("")
    setCandidates([])
    setStep("source")
    setError(null)
    setSaveProgress(null)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && isBusy) return
    if (!nextOpen) reset()
    onOpenChange(nextOpen)
  }

  const handleVendorChange = (nextVendor: MemoryImportVendor) => {
    setVendor(nextVendor)
    setCandidates([])
    setStep("source")
    setError(null)
  }

  const handleExtract = async () => {
    setIsExtracting(true)
    setError(null)
    try {
      const result = await extractImportCandidates({
        vendor,
        pastedText,
      })
      if (!result.isSuccess) {
        setError(result.message)
        return
      }
      setCandidates(candidateDrafts(result.data.candidates))
      setStep("review")
    } catch (extractError) {
      log.error("Extracting imported Nexus memories failed", {
        vendor,
        error:
          extractError instanceof Error
            ? extractError.message
            : String(extractError),
      })
      setError("Failed to extract memories. Your pasted text was not changed.")
    } finally {
      setIsExtracting(false)
    }
  }

  const handleSave = async () => {
    const selected = candidates
      .map((candidate, draftIndex) => ({ candidate, draftIndex }))
      .filter(({ candidate }) => candidate.selected)
    if (selected.length === 0) return

    setIsSaving(true)
    setSaveProgress({ completed: 0, total: selected.length })
    try {
      const {
        successful,
        failedDraftIndexes,
        requestFailureMessage,
      } = await saveCandidateBatches(vendor, selected, setSaveProgress)

      if (successful > 0) {
        try {
          await onImported()
        } catch (refreshError) {
          log.error("Refreshing memories after import failed", {
            error:
              refreshError instanceof Error
                ? refreshError.message
                : String(refreshError),
          })
          toast.warning(
            "The import was saved, but the memory list could not be refreshed",
          )
        }
      }

      if (failedDraftIndexes.size === 0) {
        toast.success(
          `${successful} ${
            successful === 1 ? "memory" : "memories"
          } imported`,
        )
        reset()
        onOpenChange(false)
        return
      }

      setCandidates((current) =>
        current
          .filter((_candidate, index) => failedDraftIndexes.has(index))
          .map((candidate) => ({ ...candidate, selected: true })),
      )
      if (successful === 0 && requestFailureMessage) {
        toast.error(requestFailureMessage)
      } else {
        toast.warning(
          `${successful} imported; ${failedDraftIndexes.size} need attention`,
        )
      }
    } catch (saveError) {
      log.error("Saving imported Nexus memories failed", {
        vendor,
        error:
          saveError instanceof Error
            ? saveError.message
            : String(saveError),
      })
      toast.error("Failed to import memories")
    } finally {
      setSaveProgress(null)
      setIsSaving(false)
    }
  }

  return {
    vendor,
    pastedText,
    candidates,
    step,
    error,
    isExtracting,
    isSaving,
    saveProgress,
    setPastedText,
    setCandidates,
    setStep,
    handleOpenChange,
    handleVendorChange,
    handleExtract,
    handleSave,
  }
}

export function MemoryImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onImported: () => Promise<void>
}) {
  const dialog = useMemoryImportDialog({ onOpenChange, onImported })

  return (
    <Dialog open={open} onOpenChange={dialog.handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import memories</DialogTitle>
          <DialogDescription>
            Bring durable context from another assistant into Nexus. You
            review every candidate before anything is saved.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {dialog.step === "source" ? (
            <ImportSourceStep
              vendor={dialog.vendor}
              pastedText={dialog.pastedText}
              error={dialog.error}
              isExtracting={dialog.isExtracting}
              onVendorChange={dialog.handleVendorChange}
              onPastedTextChange={dialog.setPastedText}
              onExtract={() => void dialog.handleExtract()}
            />
          ) : (
            <ImportReviewStep
              candidates={dialog.candidates}
              isSaving={dialog.isSaving}
              saveProgress={dialog.saveProgress}
              onCandidatesChange={dialog.setCandidates}
              onBack={() => dialog.setStep("source")}
              onSave={() => void dialog.handleSave()}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
