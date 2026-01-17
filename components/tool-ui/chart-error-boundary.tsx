'use client'

import { Component, type ReactNode } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { AlertCircle, RefreshCw } from 'lucide-react'
import { createLogger } from '@/lib/client-logger'

const log = createLogger({ moduleName: 'chart-error-boundary' })

interface ChartErrorBoundaryProps {
  children: ReactNode
  chartTitle?: string
  onRetry?: () => void
}

interface ChartErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

/**
 * Error boundary specifically for chart components.
 * Catches rendering errors from malformed chart data and displays
 * a user-friendly fallback with retry option.
 */
export class ChartErrorBoundary extends Component<
  ChartErrorBoundaryProps,
  ChartErrorBoundaryState
> {
  constructor(props: ChartErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): ChartErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    log.error('Chart rendering error', {
      error: error.message,
      componentStack: errorInfo.componentStack,
      chartTitle: this.props.chartTitle,
    })
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null })
    this.props.onRetry?.()
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <Card className="w-full border-destructive/50 bg-destructive/5">
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <CardTitle className="text-lg">Chart Error</CardTitle>
            </div>
            {this.props.chartTitle && (
              <CardDescription>
                Failed to render: {this.props.chartTitle}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              The chart could not be rendered due to invalid data or a rendering error.
            </p>
            {this.state.error && (
              <pre className="text-xs bg-muted p-2 rounded overflow-x-auto">
                {this.state.error.message}
              </pre>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={this.handleRetry}
              className="gap-2"
            >
              <RefreshCw className="h-4 w-4" />
              Retry
            </Button>
          </CardContent>
        </Card>
      )
    }

    return this.props.children
  }
}
