"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  icon?: React.ReactNode
}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, icon, ...props }, ref) => {
    /*
     * The wrapper exists ONLY to position an icon, so it is rendered only when
     * there is an icon to position.
     *
     * Previously every Input was wrapped in `<div className="relative">` while
     * `className` was applied to the inner <input>. Layout classes therefore
     * landed inside a div that did not participate in the parent's layout:
     * `<Input className="flex-1" />` inside a flex row sized to content instead
     * of filling, which is why the repository search field rendered ~190px wide
     * in a 1250px card. Same for `w-full`, `grow`, `col-span-*` and friends at
     * every other call site.
     *
     * When an icon IS present the wrapper is unavoidable, so it takes `w-full`
     * — icon inputs are full-width everywhere in this codebase.
     */
    const input = (
        <input
          type={type}
          className={cn(
            "flex h-9 w-full rounded-[var(--mer-r-button,0.375rem)] border border-input bg-background px-3 py-2 text-sm shadow-sm transition-colors",
            "file:border-0 file:bg-transparent file:text-sm file:font-medium",
            "placeholder:text-muted-foreground",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
            icon && "pl-10",
            className
          )}
          ref={ref}
          {...props}
        />
    )

    if (!icon) return input

    return (
      <div className={cn("relative w-full", className)}>
        <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
          {icon}
        </div>
        {input}
      </div>
    )
  }
)
Input.displayName = "Input"

export { Input }
