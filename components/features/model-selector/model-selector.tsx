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
import type { ModelSelectorProps } from "./model-selector-types"
import type { SelectAiModel } from "@/types"

export function ModelSelector({
  models = [],
  value,
  onChange,
  requiredCapabilities = [],
  placeholder = "Select a model",
  disabled = false,
  className,
  allowedRoles = [],
  groupByProvider = true,
  showDescription = true,
  virtualizeThreshold = 50,
  searchable = true,
  loading = false,
  error,
  hideRoleRestricted = false,
  hideCapabilityMissing = false,
  "aria-label": ariaLabel = "Select AI model",
  "aria-describedby": ariaDescribedBy
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [userRoles, setUserRoles] = useState<string[]>([])
  const commandListRef = useRef<HTMLDivElement>(null)
  const debounceTimerRef = useRef<NodeJS.Timeout | undefined>(undefined)

  // Debounce search input
  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }
    
    debounceTimerRef.current = setTimeout(() => {
      setDebouncedSearch(search)
    }, 300) // 300ms delay
    
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [search])

  // Fetch user roles on mount
  useEffect(() => {
    async function fetchUserRoles() {
      try {
        const response = await fetch('/api/user/roles')
        if (response.ok) {
          const data = await response.json()
          setUserRoles(data.roles || [])
        }
      } catch {
        // Silently fail - will just show all models without role filtering
      }
    }
    fetchUserRoles()
  }, [])

  const { 
    filteredModels, 
    groupedModels, 
    totalCount, 
    accessibleCount 
  } = useFilteredModels({
    models,
    requiredCapabilities,
    allowedRoles,
    userRoles,
    searchQuery: debouncedSearch,
    hideRoleRestricted,
    hideCapabilityMissing
  })

  const handleSelect = useCallback((model: SelectAiModel) => {
    onChange(model)
    setOpen(false)
    setSearch("")
    setDebouncedSearch("")
  }, [onChange])

  // Determine if we should use virtualization
  const shouldVirtualize = totalCount > virtualizeThreshold

  // Get display text for button
  const buttonText = useMemo(() => {
    if (value) {
      return value.name
    }
    if (accessibleCount === 0 && totalCount > 0) {
      return "No accessible models"
    }
    return placeholder
  }, [value, accessibleCount, totalCount, placeholder])

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
            {loading ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                Loading models...
              </div>
            ) : error ? (
              <div className="py-6 text-center text-sm text-destructive">
                {error}
              </div>
            ) : totalCount === 0 ? (
              <CommandEmpty>
                {search ? "No models found." : "No models available."}
              </CommandEmpty>
            ) : accessibleCount === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                No models match your access level or requirements.
              </div>
            ) : groupByProvider ? (
              sortedProviders.map((provider, index) => {
                const providerModels = groupedModels[provider]
                if (!providerModels || providerModels.length === 0) return null

                return (
                  <div key={provider}>
                    {index > 0 && <CommandSeparator />}
                    <CommandGroup 
                      heading={provider}
                      className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground"
                    >
                      {providerModels.map((model) => (
                        <ModelSelectorItem
                          key={model.id}
                          model={model}
                          isSelected={value?.id === model.id}
                          onSelect={() => handleSelect(model)}
                          showDescription={showDescription}
                          isDisabled={!model.isAccessible}
                          disabledReason={model.accessDeniedReason}
                        />
                      ))}
                    </CommandGroup>
                  </div>
                )
              })
            ) : (
              <CommandGroup>
                {filteredModels.map((model) => (
                  <ModelSelectorItem
                    key={model.id}
                    model={model}
                    isSelected={value?.id === model.id}
                    onSelect={() => handleSelect(model)}
                    showDescription={showDescription}
                    isDisabled={!model.isAccessible}
                    disabledReason={model.accessDeniedReason}
                  />
                ))}
              </CommandGroup>
            )}
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