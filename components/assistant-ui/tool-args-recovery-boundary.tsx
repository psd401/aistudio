'use client'

import { Component, type ReactNode } from 'react'
import { createLogger } from '@/lib/client-logger'

const log = createLogger({ module: 'tool-args-recovery-boundary' })

const ARGS_TEXT_ERROR_PATTERN = /argsText can only be appended/

// Cap recovery attempts to prevent infinite render loops when the argsText
// error is persistent (not a transient streaming glitch).
const MAX_RECOVERY_ATTEMPTS = 3

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
 * children on the next frame. All other errors re-throw to the parent error boundary
 * via `getDerivedStateFromError`. After MAX_RECOVERY_ATTEMPTS failed recoveries, the
 * boundary permanently renders null to avoid infinite render loops.
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

  static getDerivedStateFromError(error: Error): ToolArgsRecoveryBoundaryState {
    if (ARGS_TEXT_ERROR_PATTERN.test(error.message)) {
      return { hasArgsTextError: true, recoveryAttempt: 0 }
    }
    // Re-throw non-argsText errors so they propagate to the parent boundary.
    // React supports re-throwing from getDerivedStateFromError to achieve this.
    throw error
  }

  componentDidCatch(_error: Error): void {
    // Only argsText errors reach here (non-matching errors re-throw above).
    // Log the violation using a static pattern string rather than error.message
    // to avoid forwarding potentially PII-containing error content to server logs.
    log.warn('argsText invariant violation caught — auto-recovering', {
      toolName: this.props.toolName,
      errorPattern: 'argsText can only be appended',
    })

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

    // Cap recovery attempts: if the error is persistent (not a transient glitch),
    // stay in error state permanently rather than looping indefinitely.
    if (this.state.recoveryAttempt >= MAX_RECOVERY_ATTEMPTS) {
      log.warn('argsText recovery limit reached — rendering permanent fallback', {
        toolName: this.props.toolName,
        attempts: this.state.recoveryAttempt,
      })
      return
    }

    // Short delay to let the streaming frame stabilize before re-rendering
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
      // Return null during the recovery window — tool UI re-renders on next
      // stable streaming frame. Stays null permanently after MAX_RECOVERY_ATTEMPTS.
      return null
    }

    return this.props.children
  }
}
