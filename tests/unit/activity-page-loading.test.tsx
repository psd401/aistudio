/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ButtonHTMLAttributes, ReactNode } from "react"

const getActivityStatsMock = jest.fn()
const getNexusActivityMock = jest.fn()
const getAssistantConversationActivityMock = jest.fn()
const getComparisonActivityMock = jest.fn()

jest.mock("@/actions/admin/activity-management.actions", () => ({
  getActivityStats: (...args: unknown[]) => getActivityStatsMock(...args),
  getNexusActivity: (...args: unknown[]) => getNexusActivityMock(...args),
  getAssistantConversationActivity: (...args: unknown[]) =>
    getAssistantConversationActivityMock(...args),
  getComparisonActivity: (...args: unknown[]) =>
    getComparisonActivityMock(...args),
}))

jest.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}))

jest.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => (
    <button>{children}</button>
  ),
}))

jest.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectValue: () => null,
}))

jest.mock("@/components/ui/button", () => ({
  Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props} />
  ),
}))

jest.mock("@/components/ui/page-branding", () => ({
  PageBranding: () => <div>Branding</div>,
}))

jest.mock("@tabler/icons-react", () => ({
  IconRefresh: () => null,
}))

jest.mock(
  "@/app/(protected)/admin/activity/_components/activity-filters",
  () => ({
    ActivityFiltersComponent: ({
      onFiltersChange,
    }: {
      onFiltersChange: (filters: { userId: number }) => void
    }) => (
      <button onClick={() => onFiltersChange({ userId: 7 })}>
        Apply filter
      </button>
    ),
  })
)

jest.mock(
  "@/app/(protected)/admin/activity/_components/activity-stats-cards",
  () => ({
    ActivityStatsCards: () => <div>Stats</div>,
    ActivityStatsCardsSkeleton: () => <div>Loading stats</div>,
  })
)

jest.mock(
  "@/app/(protected)/admin/activity/_components/nexus-activity-table",
  () => ({ NexusActivityTable: () => <div>Nexus table</div> })
)

jest.mock(
  "@/app/(protected)/admin/activity/_components/assistant-conversation-table",
  () => ({ AssistantConversationTable: () => <div>Assistant table</div> })
)

jest.mock(
  "@/app/(protected)/admin/activity/_components/comparison-activity-table",
  () => ({ ComparisonActivityTable: () => <div>Comparison table</div> })
)

jest.mock(
  "@/app/(protected)/admin/activity/_components/activity-pagination",
  () => ({ ActivityPagination: () => <div>Pagination</div> })
)

jest.mock(
  "@/app/(protected)/admin/activity/_components/nexus-detail-sheet",
  () => ({ NexusDetailSheet: () => null })
)

jest.mock(
  "@/app/(protected)/admin/activity/_components/comparison-detail-sheet",
  () => ({ ComparisonDetailSheet: () => null })
)

import { ActivityPageClient } from "@/app/(protected)/admin/activity/_components/activity-page-client"

const emptyPage = {
  data: { items: [], total: 0 },
  isSuccess: true,
  message: "ok",
}

describe("activity page loading", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    getActivityStatsMock.mockResolvedValue({
      data: {},
      isSuccess: true,
      message: "ok",
    })
    getNexusActivityMock.mockResolvedValue(emptyPage)
    getAssistantConversationActivityMock.mockResolvedValue(emptyPage)
    getComparisonActivityMock.mockResolvedValue(emptyPage)
  })

  it("loads once initially and once for a filter change", async () => {
    render(<ActivityPageClient />)

    await waitFor(() => {
      expect(getNexusActivityMock).toHaveBeenCalledTimes(1)
    })

    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }))

    await waitFor(() => {
      expect(getNexusActivityMock).toHaveBeenCalledTimes(2)
    })
    expect(getNexusActivityMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, pageSize: 25, userId: 7 })
    )
  })
})
