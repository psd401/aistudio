'use client'

import { makeAssistantToolUI } from '@assistant-ui/react'
import { ToolArgsRecoveryBoundary } from '@/components/assistant-ui/tool-args-recovery-boundary'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Code2, PlayCircle, CheckCircle, XCircle, Terminal, FileText } from 'lucide-react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import Image from 'next/image'
import { isSafePlotData } from '@/lib/utils/image-validation'

interface CodeInterpreterArgs {
  code: string
  language: 'python' | 'javascript' | 'sql' | 'bash'
  context?: string
}

interface CodeInterpreterResult {
  code: string
  language: string
  context?: string
  output?: {
    stdout?: string
    stderr?: string
    returnValue?: string
    plots?: Array<{ type: string; data: string; title?: string }>
    files?: Array<{ name: string; type: string; size: number }>
  }
  executionTime: number
  status: 'success' | 'error' | 'timeout'
  error?: string
}

const getLanguageIcon = (language: string) => {
  switch (language) {
    case 'python': return '🐍'
    case 'javascript': return '⚡'
    case 'sql': return '🗃️'
    case 'bash': return '💻'
    default: return '📄'
  }
}

const getStatusIcon = (status: string) => {
  switch (status) {
    case 'success': return <CheckCircle className="h-4 w-4 text-green-600" />
    case 'error': return <XCircle className="h-4 w-4 text-red-600" />
    case 'timeout': return <XCircle className="h-4 w-4 text-orange-600" />
    default: return <PlayCircle className="h-4 w-4 text-blue-600" />
  }
}

const CodeInterpreterRenderer = ({ args, result }: { args: CodeInterpreterArgs; result?: CodeInterpreterResult }) => {
    if (!result) {
      // Loading state
      return (
        <Card className="border-green-200 bg-green-50/50">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <Code2 className="h-4 w-4 text-green-600 animate-pulse" />
              <CardTitle className="text-sm text-green-900">Executing code...</CardTitle>
            </div>
            <CardDescription className="text-xs">
              Running {args.language} code
              {args.context && ` - ${args.context}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="relative">
              <SyntaxHighlighter
                language={args.language}
                style={oneDark}
                customStyle={{
                  margin: 0,
                  borderRadius: '0.375rem',
                  fontSize: '0.75rem',
                  lineHeight: '1.4'
                }}
              >
                {args.code}
              </SyntaxHighlighter>
              <div className="absolute inset-0 bg-green-100/60 rounded flex items-center justify-center">
                <div className="flex items-center gap-2 text-green-700">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-green-600 border-t-transparent" />
                  <span className="text-sm font-medium">Executing...</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )
    }

    return (
      <Card className="border-green-200 bg-green-50/50">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Code2 className="h-4 w-4 text-green-600" />
              <CardTitle className="text-sm text-green-900">Code Execution</CardTitle>
              {getStatusIcon(result.status)}
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">
                {getLanguageIcon(result.language)} {result.language}
              </Badge>
              <Badge variant="secondary" className="text-xs">
                {result.executionTime}ms
              </Badge>
            </div>
          </div>
          {result.context && (
            <CardDescription className="text-xs">
              {result.context}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Code block */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Terminal className="h-3 w-3 text-green-600" />
              <span className="text-xs font-medium text-green-900">Code</span>
            </div>
            <SyntaxHighlighter
              language={result.language}
              style={oneDark}
              customStyle={{
                margin: 0,
                borderRadius: '0.375rem',
                fontSize: '0.75rem',
                lineHeight: '1.4'
              }}
            >
              {result.code}
            </SyntaxHighlighter>
          </div>

          {/* Output */}
          {result.output && (
            <div className="space-y-3">
              {/* Standard output */}
              {result.output.stdout && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <FileText className="h-3 w-3 text-green-600" />
                    <span className="text-xs font-medium text-green-900">Output</span>
                  </div>
                  <pre className="bg-black/80 text-green-400 p-3 rounded text-xs font-mono whitespace-pre-wrap overflow-auto max-h-40">
                    {result.output.stdout}
                  </pre>
                </div>
              )}

              {/* Error output */}
              {result.output.stderr && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <XCircle className="h-3 w-3 text-red-600" />
                    <span className="text-xs font-medium text-red-900">Error</span>
                  </div>
                  <pre className="bg-red-50 text-red-800 border border-red-200 p-3 rounded text-xs font-mono whitespace-pre-wrap overflow-auto max-h-40">
                    {result.output.stderr}
                  </pre>
                </div>
              )}

              {/* Return value */}
              {result.output.returnValue && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <CheckCircle className="h-3 w-3 text-blue-600" />
                    <span className="text-xs font-medium text-blue-900">Return Value</span>
                  </div>
                  <pre className="bg-blue-50 text-blue-800 border border-blue-200 p-3 rounded text-xs font-mono whitespace-pre-wrap overflow-auto max-h-40">
                    {result.output.returnValue}
                  </pre>
                </div>
              )}

              {/* Generated files */}
              {result.output.files && result.output.files.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <FileText className="h-3 w-3 text-purple-600" />
                    <span className="text-xs font-medium text-purple-900">Generated Files</span>
                  </div>
                  <div className="space-y-1">
                    {result.output.files.map((file, index) => (
                      <div key={index} className="flex items-center justify-between bg-purple-50 border border-purple-200 p-2 rounded text-xs">
                        <span className="font-medium text-purple-900">{file.name}</span>
                        <div className="flex items-center gap-2 text-purple-700">
                          <Badge variant="outline" className="text-xs">{file.type}</Badge>
                          <span>{(file.size / 1024).toFixed(1)}KB</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Plots */}
              {result.output.plots && result.output.plots.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs font-medium text-indigo-900">📊 Generated Plots</span>
                  </div>
                  <div className="space-y-2">
                    {result.output.plots.map((plot, index) => {
                      // Validate plot data URI before rendering — reject non-image or oversized payloads
                      if (!isSafePlotData(plot.data)) return null
                      return (
                      <div key={index} className="border border-indigo-200 rounded overflow-hidden">
                        {plot.title && (
                          <div className="bg-indigo-50 px-3 py-2 border-b border-indigo-200">
                            <span className="text-xs font-medium text-indigo-900">{plot.title}</span>
                          </div>
                        )}
                        <Image 
                          src={plot.data} 
                          alt={plot.title || `Plot ${index + 1}`}
                          width={800}
                          height={400}
                          className="w-full h-auto"
                          unoptimized // For dynamic plot data
                        />
                      </div>
                    )})}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Global error */}
          {result.status === 'error' && result.error && (
            <div className="bg-red-50 border border-red-200 p-3 rounded">
              <div className="flex items-center gap-2 mb-1">
                <XCircle className="h-3 w-3 text-red-600" />
                <span className="text-xs font-medium text-red-900">Execution Error</span>
              </div>
              <p className="text-xs text-red-800">{result.error}</p>
            </div>
          )}
        </CardContent>
      </Card>
    )
}

export const CodeInterpreterUI = makeAssistantToolUI<CodeInterpreterArgs, CodeInterpreterResult>({
  toolName: 'code_interpreter',
  render: (props) => (
    <ToolArgsRecoveryBoundary toolName="code_interpreter">
      <CodeInterpreterRenderer {...props} />
    </ToolArgsRecoveryBoundary>
  ),
})
