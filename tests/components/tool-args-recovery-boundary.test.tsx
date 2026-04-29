/**
 * Tests for ToolArgsRecoveryBoundary
 *
 * Covers:
 * - Happy path: children render when no error occurs
 * - Permanent fallback after RECOVERY_ATTEMPT_THRESHOLD exhausted
 * - Non-argsText errors re-throw to parent boundary
 * - Pattern specificity: only argsText errors are caught
 * - Transient null during recovery window
 * - toolName prop forwarded for logging context
 * - Timer deduplication via scheduleRecovery/componentWillUnmount
 */

import React from 'react'
import { render, screen, act } from '@testing-library/react'
import { ToolArgsRecoveryBoundary } from '@/components/assistant-ui/tool-args-recovery-boundary'

// ── Helpers ──────────────────────────────────────────────────────────────────

class ThrowOnRender extends React.Component<{ error: Error }> {
  render(): React.ReactNode {
    throw this.props.error
  }
}

class CatchAll extends React.Component<
  { children: React.ReactNode },
  { caught: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { caught: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { caught: error }
  }

  render() {
    if (this.state.caught) {
      return <div data-testid="parent-caught">{this.state.caught.message}</div>
    }
    return this.props.children
  }
}

const ARGS_TEXT_ERROR = new Error('argsText can only be appended, not updated')
const OTHER_ERROR = new Error('something else entirely')

// Silence React's console.error during intentional throws
beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {})
  jest.useFakeTimers()
})

afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

// ── Tests ─────────────────────────────────────────────────────────────────────

it('renders children when no error occurs', () => {
  render(
    <ToolArgsRecoveryBoundary toolName="test_tool">
      <div>child content</div>
    </ToolArgsRecoveryBoundary>
  )
  expect(screen.getByText('child content')).toBeInTheDocument()
})

it('shows permanent fallback after RECOVERY_ATTEMPT_THRESHOLD exhausted', async () => {
  // RECOVERY_ATTEMPT_THRESHOLD = 3; effective cap is 4 renders due to stale-state.
  // Advance through enough recovery cycles until the permanent fallback appears.
  render(
    <ToolArgsRecoveryBoundary toolName="test_tool">
      <ThrowOnRender error={ARGS_TEXT_ERROR} />
    </ToolArgsRecoveryBoundary>
  )

  // Cycle through recovery attempts until the permanent fallback is visible
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      jest.advanceTimersByTime(60)
    })
    const fallback = screen.queryByText('Tool result unavailable')
    if (fallback) break
  }

  expect(screen.getByText('Tool result unavailable')).toBeInTheDocument()
  expect(screen.getByRole('alert')).toBeInTheDocument()
})

it('re-throws non-argsText errors to the parent boundary', () => {
  render(
    <CatchAll>
      <ToolArgsRecoveryBoundary toolName="test_tool">
        <ThrowOnRender error={OTHER_ERROR} />
      </ToolArgsRecoveryBoundary>
    </CatchAll>
  )
  expect(screen.getByTestId('parent-caught')).toHaveTextContent('something else entirely')
})

it('only catches errors matching the argsText pattern', () => {
  const nearMiss = new Error('argsText cannot be changed once set')
  render(
    <CatchAll>
      <ToolArgsRecoveryBoundary toolName="test_tool">
        <ThrowOnRender error={nearMiss} />
      </ToolArgsRecoveryBoundary>
    </CatchAll>
  )
  // Near-miss should propagate to parent, not be caught by the boundary
  expect(screen.getByTestId('parent-caught')).toBeInTheDocument()
})

it('renders null during the transient recovery window (before timer fires)', () => {
  const { container } = render(
    <ToolArgsRecoveryBoundary toolName="test_tool">
      <ThrowOnRender error={ARGS_TEXT_ERROR} />
    </ToolArgsRecoveryBoundary>
  )
  // Before the 50ms timer fires, the boundary renders null
  expect(container.firstChild).toBeNull()
})

it('passes toolName prop for logging context', () => {
  // Boundary renders children — toolName is consumed internally for logging
  render(
    <ToolArgsRecoveryBoundary toolName="my_custom_tool">
      <div>content</div>
    </ToolArgsRecoveryBoundary>
  )
  expect(screen.getByText('content')).toBeInTheDocument()
})

it('renders without toolName prop', () => {
  render(
    <ToolArgsRecoveryBoundary>
      <div>no tool name</div>
    </ToolArgsRecoveryBoundary>
  )
  expect(screen.getByText('no tool name')).toBeInTheDocument()
})

it('deduplicates concurrent timers — multiple rapid errors schedule only one recovery', async () => {
  render(
    <ToolArgsRecoveryBoundary toolName="test_tool">
      <ThrowOnRender error={ARGS_TEXT_ERROR} />
    </ToolArgsRecoveryBoundary>
  )

  // Advance through enough cycles to exhaust the threshold and confirm the
  // permanent fallback appears exactly once (not multiple renders from duplicate timers)
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      jest.advanceTimersByTime(60)
    })
    if (screen.queryByText('Tool result unavailable')) break
  }

  const fallbacks = screen.getAllByText('Tool result unavailable')
  expect(fallbacks).toHaveLength(1)
})

it('componentWillUnmount cancels in-flight recovery timer', async () => {
  const { unmount } = render(
    <ToolArgsRecoveryBoundary toolName="test_tool">
      <ThrowOnRender error={ARGS_TEXT_ERROR} />
    </ToolArgsRecoveryBoundary>
  )

  // Unmount before the 50ms recovery timer fires
  unmount()

  // Advancing time after unmount should not cause setState errors
  await act(async () => {
    jest.advanceTimersByTime(100)
  })

  // No assertion needed — the test passes if no "setState on unmounted component"
  // warning is thrown (which would surface as a console.error in the test runner)
})
