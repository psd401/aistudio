"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

const Card = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    noPadding?: boolean
  }
>(({ className, noPadding, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      // Radius follows the design system when one is in scope, falling back to
      // the previous 12px on surfaces that have not adopted it.
      "rounded-[var(--mer-r-card,0.75rem)] border border-border bg-card text-card-foreground",
      // Opaque hairline, not `border-border/40`. The washed border was baked
      // into the primitive, so every card in the app read soft no matter what
      // its call site did.
      // No hover bloom either: a Card is a CONTAINER. The old
      // `hover:shadow-… hover:border-border/60` fired on static cards that were
      // not clickable at all. Cards that ARE targets opt in explicitly — see
      // `.mer-card-link` and the per-surface `hover:border-[var(--mer-ink-muted)]`.
      !noPadding && "p-6",
      className
    )}
    {...props}
  />
))
Card.displayName = "Card"

const CardHeader = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex flex-col space-y-3",
      className
    )}
    {...props}
  />
))
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(({ className, ...props }, ref) => (
  // eslint-disable-next-line jsx-a11y/heading-has-content -- Composable component: content provided via props.children
  <h2
    ref={ref}
    className={cn(
      "text-2xl font-semibold tracking-tight text-foreground/90",
      className
    )}
    {...props}
  />
))
CardTitle.displayName = "CardTitle"

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(({ className, ...props }, ref) => (
  <p
    ref={ref}
    className={cn(
      "text-base leading-relaxed text-muted-foreground",
      className
    )}
    {...props}
  />
))
CardDescription.displayName = "CardDescription"

const CardContent = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "mt-4 space-y-4",
      className
    )}
    {...props}
  />
))
CardContent.displayName = "CardContent"

const CardFooter = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    className={cn(
      "flex items-center gap-2 mt-6",
      className
    )}
    {...props}
  />
))
CardFooter.displayName = "CardFooter"

export { Card, CardHeader, CardFooter, CardTitle, CardDescription, CardContent }
