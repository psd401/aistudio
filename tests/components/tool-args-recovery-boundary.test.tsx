import React from 'react'
import { render, screen, act } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ToolArgsRecoveryBoundary } from '@/components/assistant-ui/tool-args-recovery-boundary'

// Suppress React error boundary console output during tests.
// React 19 logs caught errors via console.error even when handled by boundaries.
const originalConsoleError = console.error
beforeAll(() => {
  console.error = (...args: unknown[]) => {
    const msg = typeof args[0] === 'string' ? args[0] : ''
    if (
      msg.includes('Error Boundary') ||
      msg.includes('The above error occurred') ||
      msg.includes('argsText can only be appended') ||
      msg.includes('concurrent rendering') ||
      msg.includes('Something else broke')
    ) {
      return
    }
    originalConsoleError(...args)
  }
})
afterAll(() => {
  console.error = originalConsoleError
})

// Mock client-logger to avoid side effects
jest.mock('@/lib/client-logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}))

// Helper: component that always throws on render
function ThrowOnRender({ error }: { error: Error }): React.ReactNode {
  throw error
}

const ARGS_TEXT_ERROR = new Error('argsText can only be appended, not updated')
const UNRELATED_ERROR = new Error('Something else broke')

describe('ToolArgsRecoveryBoundary', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('renders children when no error occurs', () => {
    render(
      <ToolArgsRecoveryBoundary>
        <div data-testid="child">Hello</div>
      </ToolArgsRecoveryBoundary>,
    )
    expect(screen.getByTestId('child')).toHaveTextContent('Hello')
  })

  it('shows permanent fallback after RECOVERY_ATTEMPT_THRESHOLD exhausted on persistent argsText errors', async () => {
    // ThrowOnRender always throws — boundary catches, schedules recovery,
    // re-renders children which throw again, eventually hitting the cap.
    render(
      <ToolArgsRecoveryBoundary toolName="test_tool">
        <ThrowOnRender error={ARGS_TEXT_ERROR} />
      </ToolArgsRecoveryBoundary>,
    )

    // Cycle through recovery attempts (RECOVERY_ATTEMPT_THRESHOLD = 3)
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        jest.advanceTimersByTime(60)
      })
    }

    // After cap, should show permanent fallback text instead of null
    expect(screen.getByText('Tool result unavailable')).toBeInTheDocument()
  })

  it('re-throws non-argsText errors to parent boundary', () => {
    // Parent boundary to catch re-thrown errors (React 19+ behavior)
    class ParentBoundary extends React.Component<
      { children: React.ReactNode },
      { caught: boolean }
    > {
      state = { caught: false }
      static getDerivedStateFromError() {
        return { caught: true }
      }
      render() {
        if (this.state.caught) return <div data-testid="parent-caught">Parent caught</div>
        return this.props.children
      }
    }

    render(
      <ParentBoundary>
        <ToolArgsRecoveryBoundary toolName="test_tool">
          <ThrowOnRender error={UNRELATED_ERROR} />
        </ToolArgsRecoveryBoundary>
      </ParentBoundary>,
    )

    expect(screen.getByTestId('parent-caught')).toHaveTextContent('Parent caught')
  })

  it('only catches errors matching the argsText pattern', () => {
    class ParentBoundary extends React.Component<
      { children: React.ReactNode },
      { caught: boolean }
    > {
      state = { caught: false }
      static getDerivedStateFromError() {
        return { caught: true }
      }
      render() {
        if (this.state.caught) return <div data-testid="parent-caught">Parent caught</div>
        return this.props.children
      }
    }

    // Error with similar but non-matching message should propagate
    const nonMatchingError = new Error('argsText was modified incorrectly')

    render(
      <ParentBoundary>
        <ToolArgsRecoveryBoundary toolName="test_tool">
          <ThrowOnRender error={nonMatchingError} />
        </ToolArgsRecoveryBoundary>
      </ParentBoundary>,
    )

    expect(screen.getByTestId('parent-caught')).toBeInTheDocument()
  })

  it('renders null during the transient recovery window before the timer fires', () => {
    // ThrowOnRender always throws, so boundary catches and enters error state.
    // Before any timer fires, the boundary should render null (not children, not fallback).
    const { container } = render(
      <ToolArgsRecoveryBoundary toolName="test_tool">
        <ThrowOnRender error={ARGS_TEXT_ERROR} />
      </ToolArgsRecoveryBoundary>,
    )

    // Before advancing timers — boundary is in the transient null state
    // (recoveryAttempt is 0, below RECOVERY_ATTEMPT_THRESHOLD, so it renders null not fallback)
    expect(container).toBeEmptyDOMElement()
  })

  it('passes toolName prop for logging context', () => {
    render(
      <ToolArgsRecoveryBoundary toolName="web_search">
        <div>Content</div>
      </ToolArgsRecoveryBoundary>,
    )
    expect(screen.getByText('Content')).toBeInTheDocument()
  })

  it('renders without toolName prop', () => {
    render(
      <ToolArgsRecoveryBoundary>
        <div>No tool name</div>
      </ToolArgsRecoveryBoundary>,
    )
    expect(screen.getByText('No tool name')).toBeInTheDocument()
  })
})
