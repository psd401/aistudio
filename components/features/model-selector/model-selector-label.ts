import type { SelectAiModel } from "@/types"

export function getModelSelectorButtonText(
  value: Pick<SelectAiModel, "name"> | null | undefined,
  accessibleCount: number,
  totalCount: number,
  placeholder: string
): string {
  if (value) return value.name
  if (accessibleCount === 0 && totalCount > 0) return "No accessible models"
  return placeholder
}
