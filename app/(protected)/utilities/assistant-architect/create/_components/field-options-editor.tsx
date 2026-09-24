"use client"

import { useState, useCallback, useId } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
// Plain Label, NOT FormLabel: these inputs are local component state, not
// react-hook-form fields, so there is no <FormField> ancestor. FormLabel
// would call useFormField(), whose `useFormState({ name: undefined })`
// subscribes to the WHOLE form and re-renders on every keystroke, and it
// would render htmlFor="undefined-form-item" (Issue #1697).
import { Label } from "@/components/ui/label"

interface FieldOption {
  label: string
  value: string
}

interface FieldOptionsEditorProps {
  options: FieldOption[]
  onOptionsChange: (options: FieldOption[]) => void
}

export function FieldOptionsEditor({ options, onOptionsChange }: FieldOptionsEditorProps) {
  const [newOption, setNewOption] = useState<FieldOption>({ label: "", value: "" })
  const labelInputId = useId()
  const valueInputId = useId()

  const handleLabelChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNewOption(prev => ({ ...prev, label: e.target.value }))
  }, [])

  const handleValueChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNewOption(prev => ({ ...prev, value: e.target.value }))
  }, [])

  const handleAddOption = useCallback(() => {
    if (newOption.label && newOption.value) {
      onOptionsChange([...options, newOption])
      setNewOption({ label: "", value: "" })
    }
  }, [newOption, options, onOptionsChange])

  const handleRemoveOption = useCallback((index: number) => {
    onOptionsChange(options.filter((_, i) => i !== index))
  }, [options, onOptionsChange])

  return (
    <div className="border rounded-md p-3 space-y-3 bg-background">
      <h5 className="text-sm font-medium">Options</h5>
      <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
        <div>
          <Label className="text-xs" htmlFor={labelInputId}>Label</Label>
          <Input
            id={labelInputId}
            value={newOption.label}
            onChange={handleLabelChange}
            placeholder="Display text"
            className="h-8"
          />
        </div>
        <div>
          <Label className="text-xs" htmlFor={valueInputId}>Value</Label>
          <Input
            id={valueInputId}
            value={newOption.value}
            onChange={handleValueChange}
            placeholder="Stored value"
            className="h-8"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleAddOption}
          disabled={!newOption.label || !newOption.value}
        >
          Add
        </Button>
      </div>

      {options.length > 0 && (
        <OptionsList options={options} onRemove={handleRemoveOption} />
      )}
    </div>
  )
}

interface OptionsListProps {
  options: FieldOption[]
  onRemove: (index: number) => void
}

function OptionsList({ options, onRemove }: OptionsListProps) {
  return (
    <div className="space-y-1 mt-2">
      {options.map((option, index) => (
        <OptionItem key={index} option={option} index={index} onRemove={onRemove} />
      ))}
    </div>
  )
}

interface OptionItemProps {
  option: FieldOption
  index: number
  onRemove: (index: number) => void
}

function OptionItem({ option, index, onRemove }: OptionItemProps) {
  const handleRemove = useCallback(() => {
    onRemove(index)
  }, [onRemove, index])

  return (
    <div className="flex items-center justify-between border p-2 rounded text-sm">
      <div>
        <span className="font-medium">{option.label}</span>
        <span className="text-muted-foreground ml-2">({option.value})</span>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2"
        onClick={handleRemove}
      >
        Remove
      </Button>
    </div>
  )
}
