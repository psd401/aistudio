import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { RepositoryPicker } from "@/components/features/repositories/repository-picker"

const mockListRepositories = jest.fn()
const mockCreateRepository = jest.fn()
const mockToast = jest.fn()

jest.mock("@/actions/repositories/repository.actions", () => ({
  getUserAccessibleRepositoriesAction: (...args: unknown[]) =>
    mockListRepositories(...args),
  createRepository: (...args: unknown[]) => mockCreateRepository(...args),
}))
jest.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}))
jest.mock("@/components/ui/dialog", () => {
  const React = require("react")
  const pass =
    (tag: string) =>
    ({ children }: { children?: React.ReactNode }) =>
      React.createElement(tag, null, children)
  return {
    Dialog: pass("div"),
    DialogContent: pass("div"),
    DialogDescription: pass("p"),
    DialogFooter: pass("div"),
    DialogHeader: pass("div"),
    DialogTitle: pass("h2"),
  }
})
jest.mock("lucide-react", () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />
  return {
    AlertCircle: Icon,
    CheckCircle2: Icon,
    Check: Icon,
    FolderPlus: Icon,
    Info: Icon,
    Loader2: Icon,
    Lock: Icon,
    Search: Icon,
    XCircle: Icon,
  }
})

const repositories = [
  {
    id: 1,
    name: "Owned repository",
    description: "Editable",
    isPublic: false,
    itemCount: 2,
    lastUpdated: new Date("2026-07-23T12:00:00Z"),
    canManage: true,
  },
  {
    id: 2,
    name: "Shared repository",
    description: "Readable",
    isPublic: false,
    itemCount: 3,
    lastUpdated: null,
    canManage: false,
  },
]

beforeEach(() => {
  jest.clearAllMocks()
  mockListRepositories.mockResolvedValue({
    isSuccess: true,
    data: repositories,
  })
})

describe("RepositoryPicker", () => {
  it("selects from owned and shared accessible repositories", async () => {
    const onSelectionChange = jest.fn()
    const onOpenChange = jest.fn()
    render(
      <RepositoryPicker
        open
        onOpenChange={onOpenChange}
        selectedRepositoryIds={[]}
        onSelectionChange={onSelectionChange}
      />
    )

    await screen.findByText("Shared repository")
    fireEvent.click(screen.getByText("Shared repository"))

    expect(onSelectionChange).toHaveBeenCalledWith([2])
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("excludes read-only shares when a manageable destination is required", async () => {
    render(
      <RepositoryPicker
        open
        onOpenChange={jest.fn()}
        selectedRepositoryIds={[]}
        onSelectionChange={jest.fn()}
        manageableOnly
      />
    )

    await screen.findByText("Owned repository")
    expect(screen.queryByText("Shared repository")).not.toBeInTheDocument()
  })

  it("clears a stale load error after a successful reopen", async () => {
    mockListRepositories.mockResolvedValueOnce({
      isSuccess: false,
      message: "Temporary repository failure",
    })
    const props = {
      onOpenChange: jest.fn(),
      selectedRepositoryIds: [] as number[],
      onSelectionChange: jest.fn(),
    }
    const { rerender } = render(<RepositoryPicker open {...props} />)

    await screen.findByText("Temporary repository failure")

    rerender(<RepositoryPicker open={false} {...props} />)
    mockListRepositories.mockResolvedValueOnce({
      isSuccess: true,
      data: repositories,
    })
    rerender(<RepositoryPicker open {...props} />)

    await screen.findByText("Owned repository")
    expect(
      screen.queryByText("Temporary repository failure")
    ).not.toBeInTheDocument()
  })

  it("creates a private repository and selects it", async () => {
    const onSelectionChange = jest.fn()
    mockCreateRepository.mockResolvedValue({
      isSuccess: true,
      data: {
        id: 9,
        name: "New private source",
        description: "Created inline",
        ownerId: 3,
        isPublic: false,
        repositoryKind: "durable",
        lifecycleStatus: "active",
        retentionDays: null,
        expiresAt: null,
        activeIndexGenerationId: null,
        metadata: {},
        createdAt: new Date("2026-07-23T12:00:00Z"),
        updatedAt: new Date("2026-07-23T12:00:00Z"),
        canManage: true,
      },
    })
    render(
      <RepositoryPicker
        open
        onOpenChange={jest.fn()}
        selectedRepositoryIds={[]}
        onSelectionChange={onSelectionChange}
      />
    )
    await screen.findByText("Owned repository")

    fireEvent.click(
      screen.getByRole("button", { name: "Create private repository" })
    )
    fireEvent.change(screen.getByLabelText("New repository name"), {
      target: { value: "New private source" },
    })
    fireEvent.change(screen.getByLabelText("New repository description"), {
      target: { value: "Created inline" },
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Create and select" })
    )

    await waitFor(() =>
      expect(mockCreateRepository).toHaveBeenCalledWith({
        name: "New private source",
        description: "Created inline",
        isPublic: false,
      })
    )
    expect(onSelectionChange).toHaveBeenCalledWith([9])
  })
})
