"use client"

import { useCallback, useId, useMemo } from "react"
import Image from "next/image"
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage
} from "@/components/ui/form"
import type { Control, ControllerRenderProps, RefCallBack } from "react-hook-form"

interface IconPickerProps {
  control: Control<{ name: string; description?: string; imagePath: string }>
  images: string[]
}

interface IconGridProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  images: string[]
  value: string
  onChange: (value: string) => void
  fieldRef: RefCallBack
  labelId: string
}

function IconGrid({ images, value, onChange, fieldRef, labelId, ...slotProps }: IconGridProps) {
  return (
    // The grid carries the field ref so `form.setFocus("imagePath")` has
    // somewhere to land (Issue #1697) — without it a blocked submit had nothing
    // to point the user at. `tabIndex={-1}` keeps it out of the tab order while
    // still being programmatically focusable, and focusing it scrolls the
    // requirement into view. `focus:` rather than `focus-visible:` because
    // programmatic focus does not match :focus-visible.
    // `slotProps` (id / aria-invalid / aria-describedby, injected by
    // FormControl's Slot) is spread FIRST: React 19 hands `ref` to function
    // components as an ordinary prop, so a trailing spread would overwrite
    // `fieldRef` with the Slot's own empty ref and setFocus would go nowhere.
    // `role="radiogroup"` + `aria-required` so the new "(required)" marker and
    // the invalid state actually reach a screen reader: `aria-invalid` and
    // `aria-describedby` on a bare <div> with no role are not surfaced. It also
    // gives FormLabel something to name, which its `htmlFor` cannot do — a
    // <div> is not a labelable element.
    <div
      {...slotProps}
      ref={fieldRef}
      role="radiogroup"
      aria-required="true"
      aria-labelledby={labelId}
      tabIndex={-1}
      data-testid="assistant-icon-grid"
      className="grid grid-cols-4 gap-1 p-2 bg-muted rounded-lg max-h-[300px] overflow-y-auto scroll-mt-24 focus:outline-none focus:ring-2 focus:ring-ring"
    >
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
  const labelId = useId()
  return (
    <FormItem>
      <FormLabel id={labelId}>
        Icon <span className="text-destructive" aria-hidden="true">*</span>
        <span className="sr-only">(required)</span>
      </FormLabel>
      <FormControl>
        <IconGrid
          images={images}
          value={field.value}
          onChange={field.onChange}
          fieldRef={field.ref}
          labelId={labelId}
        />
      </FormControl>
      <FormDescription>Pick an icon — required before you can continue.</FormDescription>
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
      // Space as well as Enter: a native radio/button activates on both, and
      // Space is the conventional key for a radio. preventDefault stops Space
      // from scrolling the grid instead of picking the icon.
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onSelect(image)
      }
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
        // `radio` rather than `button` so the grid's radiogroup exposes WHICH
        // icon is chosen; `role="button"` announced every option identically
        // and never reported the selection.
        role="radio"
        aria-checked={isSelected}
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
        className="absolute w-32 h-32 rounded-lg overflow-hidden shadow-lg ring-1 ring-black/10 bg-card"
        style={PREVIEW_POSITION}
      >
        <Image src={`/assistant_logos/${image}`} alt={image} fill className="object-cover" sizes="128px" />
      </div>
    </div>
  )
}
