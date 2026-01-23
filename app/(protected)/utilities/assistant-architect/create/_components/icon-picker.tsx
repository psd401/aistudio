"use client"

import { useCallback, useMemo } from "react"
import Image from "next/image"
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage
} from "@/components/ui/form"
import type { Control, ControllerRenderProps } from "react-hook-form"

interface IconPickerProps {
  control: Control<{ name: string; description?: string; imagePath: string }>
  images: string[]
}

interface IconGridProps {
  images: string[]
  value: string
  onChange: (value: string) => void
}

function IconGrid({ images, value, onChange }: IconGridProps) {
  return (
    <div className="grid grid-cols-4 gap-1 p-2 bg-muted rounded-lg max-h-[300px] overflow-y-auto">
      {images.map((image) => (
        <IconOption key={image} image={image} isSelected={value === image} onSelect={onChange} />
      ))}
    </div>
  )
}

function IconPickerContent({
  field,
  images
}: {
  field: ControllerRenderProps<{ name: string; description?: string; imagePath: string }, "imagePath">
  images: string[]
}) {
  return (
    <FormItem>
      <FormLabel>Icon</FormLabel>
      <FormControl>
        <IconGrid images={images} value={field.value} onChange={field.onChange} />
      </FormControl>
      <FormMessage />
    </FormItem>
  )
}

export function IconPicker({ control, images }: IconPickerProps) {
  const renderIconPicker = useCallback(
    ({
      field
    }: {
      field: ControllerRenderProps<{ name: string; description?: string; imagePath: string }, "imagePath">
    }) => <IconPickerContent field={field} images={images} />,
    [images]
  )

  return <FormField control={control} name="imagePath" render={renderIconPicker} />
}

interface IconOptionProps {
  image: string
  isSelected: boolean
  onSelect: (value: string) => void
}

const ICON_SIZE = { width: '48px', height: '48px' } as const
const PREVIEW_POSITION = {
  bottom: 'calc(100% + 10px)',
  left: '50%',
  transform: 'translateX(-50%)'
} as const

function IconOption({ image, isSelected, onSelect }: IconOptionProps) {
  const handleClick = useCallback(() => onSelect(image), [onSelect, image])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') onSelect(image)
    },
    [onSelect, image]
  )

  const className = useMemo(() => {
    const base = "relative cursor-pointer rounded-md overflow-hidden border-2 transition-all"
    const state = isSelected
      ? 'border-primary ring-2 ring-primary'
      : 'border-transparent hover:border-muted-foreground'
    return `${base} ${state}`
  }, [isSelected])

  return (
    <div className="group relative">
      <div
        className={className}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        role="button"
        tabIndex={0}
        aria-label={`Select ${image} as assistant icon`}
        style={ICON_SIZE}
      >
        <Image src={`/assistant_logos/${image}`} alt={image} fill className="object-cover" sizes="48px" />
      </div>
      <IconPreview image={image} />
    </div>
  )
}

function IconPreview({ image }: { image: string }) {
  return (
    <div className="fixed z-[100] opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
      <div
        className="absolute w-32 h-32 rounded-lg overflow-hidden shadow-lg ring-1 ring-black/10 bg-white"
        style={PREVIEW_POSITION}
      >
        <Image src={`/assistant_logos/${image}`} alt={image} fill className="object-cover" sizes="128px" />
      </div>
    </div>
  )
}
