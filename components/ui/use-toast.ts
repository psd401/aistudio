"use client"

/**
 * `useToast()` / `toast()` — a thin adapter over sonner (Issue #1697).
 *
 * This used to be the stock shadcn implementation: a module-level reducer whose
 * queue was rendered by `components/ui/toaster.tsx`. That `<Toaster />` was
 * never mounted anywhere — `app/layout.tsx` mounts sonner's `<Toaster />`, a
 * completely separate system — so every `toast()` call in the app pushed onto a
 * queue nothing subscribed to. Roughly 60 files call this hook, and all of them
 * were silently mute in production; the Assistant Architect create flow was the
 * reported casualty (blocked validation reported only through a toast that
 * never rendered, so "Continue" looked like a dead button).
 *
 * Rather than mount a second toast root, this forwards to the one that is
 * already mounted. There is deliberately no React state here: three call sites
 * invoke `toast()` from outside a component.
 */

import type * as React from "react"
import { toast as sonnerToast } from "sonner"

export interface ToastOptions {
  title?: React.ReactNode
  description?: React.ReactNode
  /** `destructive` renders as an error toast; anything else is neutral. */
  variant?: "default" | "destructive"
  duration?: number
  /** sonner accepts a ReactNode action, so shadcn's action element passes straight through. */
  action?: React.ReactNode
}

export interface ToastHandle {
  id: string | number
  dismiss: () => void
  update: (options: ToastOptions) => void
}

/**
 * shadcn splits a toast into `title` + `description`; sonner takes a single
 * message plus options. Use the title as the message when present so the
 * emphasis matches the original call site, and fall back to the description so
 * a description-only toast is never dropped.
 */
function emit(options: ToastOptions, id?: string | number): string | number {
  const { title, description, variant, duration, action } = options
  const message = title ?? description
  const data = {
    description: title == null ? undefined : description,
    duration,
    action,
    ...(id === undefined ? {} : { id }),
  }

  return variant === "destructive"
    ? sonnerToast.error(message, data)
    : sonnerToast(message, data)
}

export function toast(options: ToastOptions): ToastHandle {
  const id = emit(options)

  return {
    id,
    dismiss: () => sonnerToast.dismiss(id),
    // Re-emitting with the same id is sonner's update mechanism.
    update: (next: ToastOptions) => {
      emit(next, id)
    },
  }
}

export function useToast() {
  return {
    toast,
    dismiss: (toastId?: string | number) => sonnerToast.dismiss(toastId),
  }
}
