import { render } from '@testing-library/react'
import { screen } from '@testing-library/dom'
import '@testing-library/jest-dom'

/**
 * Component test (#1172): the admin triage detail page renders the four new
 * Phase-2 sections — escalation mode/threshold, sweep status, learned
 * patterns, and pending suggestions — from a populated triage state. Runs
 * deterministically (no DynamoDB) by mocking the server action.
 */

// `mock`-prefixed so the jest.mock factory may close over it (jest hoist rule).
const mockSummary = {
  userEmail: 'hagelk@psd401.net',
  enabled: true,
  enabledAt: '2026-07-01T00:00:00Z',
  disabledAt: null,
  labels: { important: '@psd/Important', later: '@psd/Later', news: '@psd/News' },
  labelIdsByKey: { important: 'Label_1', later: 'Label_2', news: 'Label_3' },
  lastHistoryId: '12345',
  lastPollAt: '2026-07-10T12:00:00Z',
  escalationMode: 'high-confidence',
  escalationConfidenceThreshold: 0.85,
  sweep: {
    status: 'running',
    processed: 120,
    labeled: 108,
    cap: 1000,
    windowDays: 30,
    pageToken: 'p3',
    startedAt: '2026-07-10T11:00:00Z',
    updatedAt: '2026-07-10T11:30:00Z',
  },
  learnedAt: '2026-07-10T09:00:00Z',
  digest: { enabled: true, time: '08:00', tz: 'America/Los_Angeles' },
  counts: {
    vipSenders: 1,
    muteSenders: 2,
    keywordRules: 0,
    escalationSenders: 0,
    escalationKeywords: 0,
    recentDecisions: 5,
    recentCorrections: 3,
    learnedPatterns: 2,
    pendingSuggestions: 1,
  },
  learnedPatterns: [
    { pattern: 'noise@vendor.com', weight: 3.2, kind: 'mute', count: 3, source: 'correction' },
    { pattern: 'boss@psd401.net', weight: 2.1, kind: 'vip', count: 2, source: 'correction' },
  ],
  pendingSuggestions: [
    {
      id: 'mute:noise@vendor.com',
      kind: 'mute',
      target: 'noise@vendor.com',
      reason: 'You archived 3 "important" emails from noise@vendor.com — mute them?',
      count: 3,
      weight: 3.2,
      createdAt: '2026-07-10T09:00:00Z',
    },
  ],
  recentDecisions: [],
  recentCorrections: [],
}

jest.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: jest.fn() }),
}))

// The alert-dialog wrapper touches @radix-ui primitives at module load
// (Portal.displayName), which is undefined under jsdom. The dialog is closed
// in these tests, so a passthrough mock is sufficient.
jest.mock('@/components/ui/alert-dialog', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react')
  const passthrough = (name: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const C = ({ children, ...props }: any) =>
      React.createElement('div', props, children)
    C.displayName = name
    return C
  }
  return {
    AlertDialog: passthrough('AlertDialog'),
    AlertDialogAction: passthrough('AlertDialogAction'),
    AlertDialogCancel: passthrough('AlertDialogCancel'),
    AlertDialogContent: passthrough('AlertDialogContent'),
    AlertDialogDescription: passthrough('AlertDialogDescription'),
    AlertDialogFooter: passthrough('AlertDialogFooter'),
    AlertDialogHeader: passthrough('AlertDialogHeader'),
    AlertDialogTitle: passthrough('AlertDialogTitle'),
  }
})

jest.mock('@/actions/admin/agent-triage.actions', () => ({
  getTriageState: jest.fn(async () => ({
    isSuccess: true,
    data: mockSummary,
    message: 'ok',
  })),
  pauseTriage: jest.fn(),
  resetLearnedPatterns: jest.fn(),
  forceReonboard: jest.fn(),
}))

// eslint-disable-next-line import/first
import { TriageDetailClient } from './triage-detail-client'

describe('TriageDetailClient (#1172 sections)', () => {
  test('renders escalation, sweep, learned-patterns, and suggestions sections', async () => {
    render(<TriageDetailClient userEmail="hagelk@psd401.net" />)

    // Section headings. ("Learned patterns" / "Pending suggestions" also
    // appear as Counts labels, so assert at-least-one match for those.)
    expect(await screen.findByText('Escalation')).toBeInTheDocument()
    expect(screen.getByText('Sweep')).toBeInTheDocument()
    expect(screen.getAllByText('Learned patterns').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Pending suggestions').length).toBeGreaterThan(0)

    // Escalation mode + threshold values render.
    expect(screen.getByText('high-confidence')).toBeInTheDocument()
    expect(screen.getByText('0.85')).toBeInTheDocument()

    // Sweep progress renders.
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText('120 / 1000')).toBeInTheDocument()

    // Learned patterns render.
    expect(screen.getByText('noise@vendor.com')).toBeInTheDocument()
    expect(screen.getByText('boss@psd401.net')).toBeInTheDocument()

    // Pending suggestion renders with its id.
    expect(
      screen.getByText(/You archived 3 "important" emails from noise@vendor.com/),
    ).toBeInTheDocument()
    expect(screen.getByText('mute:noise@vendor.com')).toBeInTheDocument()
  })

  test('shows empty states when learning + suggestions are empty', async () => {
    const {
      getTriageState,
    } = require('@/actions/admin/agent-triage.actions') as {
      getTriageState: jest.Mock
    }
    getTriageState.mockResolvedValueOnce({
      isSuccess: true,
      data: {
        ...mockSummary,
        escalationMode: 'all',
        sweep: null,
        learnedPatterns: [],
        pendingSuggestions: [],
        counts: { ...mockSummary.counts, learnedPatterns: 0, pendingSuggestions: 0 },
      },
      message: 'ok',
    })

    render(<TriageDetailClient userEmail="hagelk@psd401.net" />)

    expect(
      await screen.findByText('No sweep has been run for this user.'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('(none yet — populated by the nightly learning job)'),
    ).toBeInTheDocument()
    expect(
      screen.getByText('(none — the user has no pending rule suggestions)'),
    ).toBeInTheDocument()
  })
})
