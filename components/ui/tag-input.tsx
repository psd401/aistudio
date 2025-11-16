"use client"

import React, { useState, useRef, KeyboardEvent } from "react"
import { X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

interface TagInputProps {
  id?: string
  value: string[]
  onChange: (tags: string[]) => void
  placeholder?: string
  maxTags?: number
  disabled?: boolean
  className?: string
}

export function TagInput({
  id,
  value = [],
  onChange,
  placeholder = "Add tags (press Enter)",
  maxTags = 10,
  disabled = false,
  className = ""
}: TagInputProps) {
  const [inputValue, setInputValue] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault()
      addTag()
    } else if (e.key === "Backspace" && inputValue === "" && value.length > 0) {
      // Remove last tag when backspace is pressed on empty input
      removeTag(value.length - 1)
    }
  }

  const addTag = () => {
    const trimmedValue = inputValue.trim()

    if (!trimmedValue) return

    // Check if tag already exists (case insensitive)
    if (value.some(tag => tag.toLowerCase() === trimmedValue.toLowerCase())) {
      setInputValue("")
      return
    }

    // Check max tags limit
    if (value.length >= maxTags) {
      setInputValue("")
      return
    }

    onChange([...value, trimmedValue])
    setInputValue("")
  }

  const removeTag = (indexToRemove: number) => {
    onChange(value.filter((_, index) => index !== indexToRemove))
    inputRef.current?.focus()
  }

  return (
    <div
      className={`flex min-h-[40px] w-full flex-wrap gap-1.5 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 ${disabled ? "cursor-not-allowed opacity-50" : ""} ${className}`}
      onClick={() => inputRef.current?.focus()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          inputRef.current?.focus()
        }
      }}
      role="button"
      tabIndex={0}
    >
      {value.map((tag, index) => (
        <Badge
          key={index}
          variant="secondary"
          className="flex items-center gap-1 px-2 py-0.5"
        >
          <span>{tag}</span>
          {!disabled && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-auto p-0 ml-1 hover:bg-transparent"
              onClick={(e) => {
                e.stopPropagation()
                removeTag(index)
              }}
              tabIndex={-1}
            >
              <X className="h-3 w-3" />
              <span className="sr-only">Remove {tag}</span>
            </Button>
          )}
        </Badge>
      ))}
      <Input
        ref={inputRef}
        id={id}
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={value.length === 0 ? placeholder : ""}
        disabled={disabled || value.length >= maxTags}
        className="h-7 flex-1 border-0 bg-transparent p-0 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:cursor-not-allowed"
      />
      {value.length > 0 && (
        <div className="text-xs text-muted-foreground self-center">
          {value.length}/{maxTags}
        </div>
      )}
    </div>
  )
}
