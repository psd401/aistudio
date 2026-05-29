/**
 * Tests for ToolsPopover auto-enable web search behavior.
 *
 * Covers:
 * - Auto-enables webSearch when model supports it and no tools are enabled
 * - Does NOT auto-enable when model doesn't support webSearch
 * - Does NOT auto-enable when user already has tools enabled
 * - Preserves valid enabled tools when switching to a model that supports a subset
 * - Clears invalid tools when the new model doesn't support them (no auto-enable)
 */

import React from 'react'
import { render, act, waitFor } from '@testing-library/react'
import { ToolsPopover } from '@/app/(protected)/nexus/_components/chat/tools-popover'
import type { SelectAiModel } from '@/types'
import type { ToolConfig } from '@/lib/tools/client-tool-registry'

// ── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('@/lib/tools/client-tool-registry', () => ({
  getAvailableToolsForModel: jest.fn(),
  getAllTools: jest.fn(() => []),
}))

jest.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

jest.mock('@/components/ui/switch', () => ({
  Switch: ({ checked, onCheckedChange }: { checked: boolean; onCheckedChange: () => void }) => (
    <input type="checkbox" checked={checked} onChange={onCheckedChange} />
  ),
}))

jest.mock('@/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}))

jest.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children: React.ReactNode; [key: string]: unknown }) => (
    <button {...(props as object)}>{children}</button>
  ),
}))

jest.mock('lucide-react', () => ({
  Wrench: () => <span>wrench</span>,
  Globe: () => <span>globe</span>,
  Code2: () => <span>code2</span>,
  ImageIcon: () => <span>image</span>,
}))

jest.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

// ── Helpers ──────────────────────────────────────────────────────────────────

import { getAvailableToolsForModel } from '@/lib/tools/client-tool-registry'
const mockGetAvailableTools = getAvailableToolsForModel as jest.MockedFunction<
  typeof getAvailableToolsForModel
>

const WEB_SEARCH_TOOL: ToolConfig = {
  name: 'webSearch',
  tool: {},
  requiredCapabilities: ['webSearch', 'grounding'],
  displayName: 'Web Search',
  description: 'Search the web for current information and facts',
  category: 'search',
}

const CODE_TOOL: ToolConfig = {
  name: 'codeInterpreter',
  tool: {},
  requiredCapabilities: ['codeInterpreter', 'codeExecution'],
  displayName: 'Code Interpreter',
  description: 'Execute code',
  category: 'code',
}

const makeModel = (id: string): SelectAiModel =>
  ({ modelId: id, name: id, provider: 'openai' } as unknown as SelectAiModel)

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ToolsPopover — auto-enable web search', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('auto-enables webSearch when model supports it and no tools are currently enabled', async () => {
    mockGetAvailableTools.mockResolvedValue([WEB_SEARCH_TOOL])
    const onToolsChange = jest.fn()

    render(
      <ToolsPopover
        selectedModel={makeModel('gpt-5')}
        enabledTools={[]}
        onToolsChange={onToolsChange}
      />
    )

    await waitFor(() => {
      expect(onToolsChange).toHaveBeenCalledWith(['webSearch'])
    })
  })

  it('does NOT auto-enable webSearch when model does not support it', async () => {
    mockGetAvailableTools.mockResolvedValue([CODE_TOOL])
    const onToolsChange = jest.fn()

    render(
      <ToolsPopover
        selectedModel={makeModel('bedrock-claude')}
        enabledTools={[]}
        onToolsChange={onToolsChange}
      />
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(onToolsChange).not.toHaveBeenCalled()
  })

  it('does NOT auto-enable webSearch when user already has tools enabled', async () => {
    mockGetAvailableTools.mockResolvedValue([WEB_SEARCH_TOOL, CODE_TOOL])
    const onToolsChange = jest.fn()

    render(
      <ToolsPopover
        selectedModel={makeModel('gpt-5')}
        enabledTools={['codeInterpreter']}
        onToolsChange={onToolsChange}
      />
    )

    await act(async () => {
      await Promise.resolve()
    })

    // codeInterpreter is still valid for this model — no change expected
    expect(onToolsChange).not.toHaveBeenCalled()
  })

  it('removes invalid tools when switching models, without auto-enabling webSearch', async () => {
    // User had codeInterpreter enabled; new model only supports webSearch
    mockGetAvailableTools.mockResolvedValue([WEB_SEARCH_TOOL])
    const onToolsChange = jest.fn()

    render(
      <ToolsPopover
        selectedModel={makeModel('gemini')}
        enabledTools={['codeInterpreter']}
        onToolsChange={onToolsChange}
      />
    )

    await waitFor(() => {
      // Should strip the invalid tool but not auto-add webSearch
      expect(onToolsChange).toHaveBeenCalledWith([])
    })

    // Must NOT have been called with webSearch
    expect(onToolsChange).not.toHaveBeenCalledWith(['webSearch'])
  })

  it('does nothing when no model is selected', async () => {
    const onToolsChange = jest.fn()

    render(
      <ToolsPopover
        selectedModel={null}
        enabledTools={[]}
        onToolsChange={onToolsChange}
      />
    )

    await act(async () => {
      await Promise.resolve()
    })

    expect(mockGetAvailableTools).not.toHaveBeenCalled()
    expect(onToolsChange).not.toHaveBeenCalled()
  })
})
