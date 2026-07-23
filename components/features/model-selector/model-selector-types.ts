import type { SelectAiModel } from "@/types"

export interface ModelSelectorProps {
  models?: SelectAiModel[]
  value?: SelectAiModel | null
  onChange: (model: SelectAiModel) => void
  requiredCapabilities?: string[]
  /** Model must have at least one of these capabilities (OR logic). Combined with requiredCapabilities (AND). */
  anyOfCapabilities?: string[]
  placeholder?: string
  disabled?: boolean
  className?: string
  groupByProvider?: boolean
  showDescription?: boolean
  virtualizeThreshold?: number
  searchable?: boolean
  loading?: boolean
  error?: string
  hideCapabilityMissing?: boolean
  "aria-label"?: string
  "aria-describedby"?: string
}

export interface ModelSelectorItemProps {
  model: SelectAiModel
  isSelected: boolean
  onSelect: () => void
  showDescription?: boolean
  isDisabled?: boolean
  disabledReason?: string
}

export interface FilteredModel extends SelectAiModel {
  isAccessible: boolean
  accessDeniedReason?: string
  matchesCapabilities: boolean
  missingCapabilities?: string[]
}

export interface UseFilteredModelsOptions {
  models: SelectAiModel[]
  requiredCapabilities?: string[]
  /** Model must have at least one of these capabilities (OR logic). Combined with requiredCapabilities (AND). */
  anyOfCapabilities?: string[]
  searchQuery?: string
  hideCapabilityMissing?: boolean
}

export interface UseFilteredModelsResult {
  filteredModels: FilteredModel[]
  groupedModels: Record<string, FilteredModel[]>
  totalCount: number
  accessibleCount: number
}