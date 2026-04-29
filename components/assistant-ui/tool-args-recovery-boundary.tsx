'use client'

import { Component, type ReactNode } from 'react'
import { createLogger } from '@/lib/client-logger'

const log = createLogger({ module: 'tool-args-recovery-boundary' })

const ARGS_TEXT_ERROR_PATTERN = /argsText can only be appended/

// Comparison threshold for capping recovery attempts.
// componentDidCatch stops scheduling new recovery timers once recoveryAttempt
// reaches this value. Due to stale-state reads (the counter increments in an
// async setState 50ms later), the effective cap is THRESHOLD + 1 (i.e. 4) — the
// threshold is intentionally named to reflect that it is a >= comparison value,
// not the exact maximum count.
const RECOVERY_ATTEMPT_THRESHOLD = 3

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
 * via `getDerivedStateFromError`. After RECOVERY_ATTEMPT_THRESHOLD failed recoveries, the
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

  static getDerivedStateFromError(
    error: Error,
  ): Partial<ToolArgsRecoveryBoundaryState> {
    if (ARGS_TEXT_ERROR_PATTERN.test(error.message)) {
      // Return only hasArgsTextError — intentionally do NOT reset recoveryAttempt
      // so the counter accumulates correctly across multiple errors and the
      // RECOVERY_ATTEMPT_THRESHOLD cap in componentDidCatch functions correctly.
      return { hasArgsTextError: true }
    }
    // Re-throw non-argsText errors so they propagate to the parent boundary.
    // This project requires react@^19.2.4 (see package.json), which supports
    // re-throwing from getDerivedStateFromError. React 18 silently swallows
    // such re-throws — do not downgrade below React 19 without updating this.
    throw error
  }

  componentDidCatch(_error: Error): void {
    // Only argsText errors reach here (non-matching errors re-throw in getDerivedStateFromError).
    // Check the cap before scheduling recovery — recoveryAttempt reflects cumulative attempts
    // since constructor (getDerivedStateFromError does not reset it).
    //
    // Note: this.state.recoveryAttempt may be stale if componentDidCatch fires multiple times
    // before the 50ms timer in scheduleRecovery resolves (the increment is in the async
    // setState callback). In practice, clearTimeout deduplication in scheduleRecovery prevents
    // multiple timers from running concurrently, so at most one extra recovery may slip through.
    if (this.state.recoveryAttempt >= RECOVERY_ATTEMPT_THRESHOLD) {
      log.warn('argsText recovery limit reached — rendering permanent fallback', {
        toolName: this.props.toolName,
        attempts: this.state.recoveryAttempt,
      })
      // Do not schedule recovery — boundary stays in null-render state permanently.
      return
    }

    // Log the violation using a static pattern string rather than error.message
    // to avoid forwarding potentially PII-containing error content to server logs.
    log.warn('argsText invariant violation caught — auto-recovering', {
      toolName: this.props.toolName,
      errorPattern: 'argsText can only be appended',
      recoveryAttempt: this.state.recoveryAttempt + 1,
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
      if (this.state.recoveryAttempt >= RECOVERY_ATTEMPT_THRESHOLD) {
        // Permanent fallback — recovery exhausted, show user-visible message.
        // No new recovery is scheduled because componentDidCatch returns early
        // when the cap is reached, so hasArgsTextError stays true permanently.
        return (
          <div role="alert" className="text-xs text-muted-foreground italic p-2">
            Tool result unavailable
          </div>
        )
      }
      // Transient null during recovery window — tool UI re-renders on next
      // stable streaming frame after the 50ms timer fires.
      return null
    }

    return this.props.children
  }
}
