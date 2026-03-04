'use client'

import { Component, type ReactNode } from 'react'
import { createLogger } from '@/lib/client-logger'

const log = createLogger({ module: 'tool-args-recovery-boundary' })

const ARGS_TEXT_ERROR_PATTERN = /argsText can only be appended/

interface ToolArgsRecoveryBoundaryProps {
  children: ReactNode
  /** Tool name for logging context */
  toolName?: string
}

interface ToolArgsRecoveryBoundaryState {
  hasArgsTextError: boolean
  recoveryAttempt: number
}

/**
 * Error boundary that catches the assistant-ui `argsText can only be appended, not updated`
 * invariant violation during tool call streaming.
 *
 * This error is thrown by `useToolInvocations` when the AI SDK emits intermediate streaming
 * states where `part.input` briefly disappears or keys are reordered, causing `argsText` to
 * change non-append-only. The underlying data is almost always valid — the error is a
 * transient streaming glitch.
 *
 * This boundary catches the specific argsText error and auto-recovers by re-rendering
 * children on the next frame. All other errors pass through to the parent error boundary.
 *
 * @see https://github.com/assistant-ui/assistant-ui/issues/2775
 * @see https://github.com/assistant-ui/assistant-ui/issues/3471
 */
export class ToolArgsRecoveryBoundary extends Component<
  ToolArgsRecoveryBoundaryProps,
  ToolArgsRecoveryBoundaryState
> {
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null

  constructor(props: ToolArgsRecoveryBoundaryProps) {
    super(props)
    this.state = { hasArgsTextError: false, recoveryAttempt: 0 }
  }

  static getDerivedStateFromError(error: Error): ToolArgsRecoveryBoundaryState | null {
    if (ARGS_TEXT_ERROR_PATTERN.test(error.message)) {
      return { hasArgsTextError: true, recoveryAttempt: 0 }
    }
    // Re-throw non-argsText errors to parent boundary
    return null
  }

  componentDidCatch(error: Error): void {
    if (!ARGS_TEXT_ERROR_PATTERN.test(error.message)) {
      // Not our error — let it propagate
      throw error
    }

    log.warn('argsText invariant violation caught — auto-recovering', {
      toolName: this.props.toolName,
      message: error.message,
    })

    // Schedule auto-recovery on next frame so the streaming can stabilize
    this.scheduleRecovery()
  }

  componentWillUnmount(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer)
    }
  }

  private scheduleRecovery(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer)
    }

    // Use a short delay to let the streaming frame stabilize
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null
      this.setState((prev) => ({
        hasArgsTextError: false,
        recoveryAttempt: prev.recoveryAttempt + 1,
      }))
    }, 50)
  }

  render(): ReactNode {
    if (this.state.hasArgsTextError) {
      // Return null during the brief recovery window — the tool UI will
      // re-render on the next stable streaming frame (50ms delay)
      return null
    }

    return this.props.children
  }
}
