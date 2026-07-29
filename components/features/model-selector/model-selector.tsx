"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList,
  CommandSeparator
} from "@/components/ui/command"
import { IconRobot, IconChevronDown } from "@tabler/icons-react"
import { cn } from "@/lib/utils"
import { useFilteredModels } from "./use-filtered-models"
import { ModelSelectorItem } from "./model-selector-item"
import { getModelSelectorButtonText } from "./model-selector-label"
import type {
  FilteredModel,
  ModelSelectorProps,
} from "./model-selector-types"
import type { SelectAiModel } from "@/types"

interface ModelListProps {
  accessibleCount: number
  error?: string
  filteredModels: FilteredModel[]
  groupedModels: Record<string, FilteredModel[]>
  groupByProvider: boolean
  handleSelect: (model: SelectAiModel) => void
  loading: boolean
  search: string
  selectedId?: number
  showDescription: boolean
  sortedProviders: string[]
  totalCount: number
}

function SelectorItem({
  handleSelect,
  model,
  selectedId,
  showDescription,
}: {
  handleSelect: (model: SelectAiModel) => void
  model: FilteredModel
  selectedId?: number
  showDescription: boolean
}) {
  return (
    <ModelSelectorItem
      model={model}
      isSelected={selectedId === model.id}
      onSelect={() => handleSelect(model)}
      showDescription={showDescription}
      isDisabled={!model.isAccessible}
      disabledReason={model.accessDeniedReason}
    />
  )
}

function GroupedModelList(props: ModelListProps) {
  return props.sortedProviders.map((provider, index) => {
    const providerModels = props.groupedModels[provider]
    if (!providerModels?.length) return null

    return (
      <div key={provider}>
        {index > 0 && <CommandSeparator />}
        <CommandGroup
          heading={provider}
          className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground"
        >
          {providerModels.map((model) => (
            <SelectorItem
              handleSelect={props.handleSelect}
              key={model.id}
              model={model}
              selectedId={props.selectedId}
              showDescription={props.showDescription}
            />
          ))}
        </CommandGroup>
      </div>
    )
  })
}

function ModelListContent(props: ModelListProps) {
  if (props.loading) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        Loading models...
      </div>
    )
  }
  if (props.error) {
    return (
      <div className="py-6 text-center text-sm text-destructive">
        {props.error}
      </div>
    )
  }
  if (props.totalCount === 0) {
    return (
      <CommandEmpty>
        {props.search ? "No models found." : "No models available."}
      </CommandEmpty>
    )
  }
  if (props.accessibleCount === 0) {
    return (
      <div className="py-6 text-center text-sm text-muted-foreground">
        No models match your access level or requirements.
      </div>
    )
  }
  if (props.groupByProvider) return <GroupedModelList {...props} />

  return (
    <CommandGroup>
      {props.filteredModels.map((model) => (
        <SelectorItem
          handleSelect={props.handleSelect}
          key={model.id}
          model={model}
          selectedId={props.selectedId}
          showDescription={props.showDescription}
        />
      ))}
    </CommandGroup>
  )
}

type ResolvedModelSelectorProps = ModelSelectorProps & {
  anyOfCapabilities: string[]
  disabled: boolean
  groupByProvider: boolean
  hideCapabilityMissing: boolean
  loading: boolean
  models: SelectAiModel[]
  placeholder: string
  requiredCapabilities: string[]
  searchable: boolean
  showDescription: boolean
  virtualizeThreshold: number
}

function useDebouncedSearch(search: string) {
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const debounceTimerRef = useRef<NodeJS.Timeout | undefined>(undefined)

  useEffect(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)

    debounceTimerRef.current = setTimeout(() => {
      setDebouncedSearch(search)
    }, 300)

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    }
  }, [search])

  return [debouncedSearch, setDebouncedSearch] as const
}

function ModelSelectorContent({
  models,
  value,
  onChange,
  requiredCapabilities,
  anyOfCapabilities,
  placeholder,
  disabled,
  className,
  groupByProvider,
  showDescription,
  virtualizeThreshold,
  searchable,
  loading,
  error,
  hideCapabilityMissing,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedBy
}: ResolvedModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useDebouncedSearch(search)
  const commandListRef = useRef<HTMLDivElement>(null)

  // NOTE (#1207): the ModelSelector no longer fetches the user's roles. Per-model
  // role/group access is enforced server-side — GET /api/models filters the list
  // through resource_access_grants (#1206), so an inaccessible model never reaches
  // this component. The former /api/user/roles fetch existed only to drive the
  // now-removed client-side role filter. Only capability filtering remains.

  const {
    filteredModels,
    groupedModels,
    totalCount,
    accessibleCount
  } = useFilteredModels({
    models,
    requiredCapabilities,
    anyOfCapabilities,
    searchQuery: debouncedSearch,
    hideCapabilityMissing
  })

  const handleSelect = useCallback((model: SelectAiModel) => {
    onChange(model)
    setOpen(false)
    setSearch("")
    setDebouncedSearch("")
  }, [onChange, setDebouncedSearch])

  // Determine if we should use virtualization
  const shouldVirtualize = totalCount > virtualizeThreshold

  // Get display text for button
  const buttonText = useMemo(
    () =>
      getModelSelectorButtonText(
        value,
        accessibleCount,
        totalCount,
        placeholder
      ),
    [value, accessibleCount, totalCount, placeholder]
  )

  // Sort providers alphabetically
  const sortedProviders = useMemo(() => {
    return Object.keys(groupedModels).sort((a, b) => a.localeCompare(b))
  }, [groupedModels])

  return (
    <Popover open={open} onOpenChange={setOpen} modal={true}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
          className={cn(
            "justify-between",
            !value && "text-muted-foreground",
            className
          )}
          disabled={disabled || loading || models.length === 0}
        >
          <div className="flex items-center gap-2 truncate">
            <IconRobot className="h-4 w-4 opacity-70" aria-hidden="true" />
            <span className="truncate">{buttonText}</span>
          </div>
          <IconChevronDown 
            className={cn(
              "ml-2 h-4 w-4 opacity-50 transition-transform",
              open && "rotate-180"
            )} 
            aria-hidden="true" 
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent 
        className="w-[400px] p-0 z-[100]" 
        align="start"
        onOpenAutoFocus={(e) => {
          // Focus the search input when opening
          e.preventDefault()
          const target = e.currentTarget as HTMLElement | null
          if (target) {
            const searchInput = target.querySelector('[cmdk-input]') as HTMLInputElement
            searchInput?.focus()
          }
        }}
      >
        <Command shouldFilter={false}>
          {searchable && (
            <CommandInput 
              placeholder="Search models..." 
              value={search}
              onValueChange={setSearch}
              className="h-9"
            />
          )}
          
          <CommandList
            ref={commandListRef}
            className={cn(
              "max-h-[400px] overflow-y-auto overscroll-contain",
              shouldVirtualize && "will-change-scroll"
            )}
            style={{ touchAction: 'pan-y' }}
            // Prevent Radix UI Popover from blocking scroll events
            // See: https://github.com/pacocoursey/cmdk/issues/159
            onWheel={(e) => e.stopPropagation()}
          >
            <ModelListContent
              accessibleCount={accessibleCount}
              error={error}
              filteredModels={filteredModels}
              groupedModels={groupedModels}
              groupByProvider={groupByProvider}
              handleSelect={handleSelect}
              loading={loading}
              search={search}
              selectedId={value?.id}
              showDescription={showDescription}
              sortedProviders={sortedProviders}
              totalCount={totalCount}
            />
          </CommandList>
          
          {totalCount > 0 && (
            <div className="border-t px-3 py-2 text-xs text-muted-foreground">
              {accessibleCount} of {totalCount} models available
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function ModelSelector(props: ModelSelectorProps) {
  return (
    <ModelSelectorContent
      {...props}
      anyOfCapabilities={props.anyOfCapabilities ?? []}
      disabled={props.disabled ?? false}
      groupByProvider={props.groupByProvider ?? true}
      hideCapabilityMissing={props.hideCapabilityMissing ?? false}
      loading={props.loading ?? false}
      models={props.models ?? []}
      placeholder={props.placeholder ?? "Select a model"}
      requiredCapabilities={props.requiredCapabilities ?? []}
      searchable={props.searchable ?? true}
      showDescription={props.showDescription ?? true}
      virtualizeThreshold={props.virtualizeThreshold ?? 50}
      aria-label={props["aria-label"] ?? "Select AI model"}
    />
  )
}
