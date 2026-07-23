import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { RepositoryAccessEditor } from "@/components/features/repositories/repository-access-editor"

const mockGetRepositoryAccess = jest.fn()
const mockGetRepositoryAccessOptions = jest.fn()
const mockGrantRepositoryAccess = jest.fn()
const mockRevokeRepositoryAccess = jest.fn()
const mockToast = jest.fn()

jest.mock("@/actions/repositories/repository.actions", () => ({
  getRepositoryAccess: (...args: unknown[]) =>
    mockGetRepositoryAccess(...args),
  getRepositoryAccessOptions: (...args: unknown[]) =>
    mockGetRepositoryAccessOptions(...args),
  grantRepositoryAccess: (...args: unknown[]) =>
    mockGrantRepositoryAccess(...args),
  revokeRepositoryAccess: (...args: unknown[]) =>
    mockRevokeRepositoryAccess(...args),
}))
jest.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}))
jest.mock("lucide-react", () => {
  const Icon = (props: React.HTMLAttributes<HTMLSpanElement>) => (
    <span {...props} />
  )
  return {
    AlertCircle: Icon,
    CheckCircle2: Icon,
    Info: Icon,
    Loader2: Icon,
    Search: Icon,
    Shield: Icon,
    Trash2: Icon,
    UserRound: Icon,
    XCircle: Icon,
  }
})

beforeEach(() => {
  jest.clearAllMocks()
  mockGetRepositoryAccess.mockResolvedValue({
    isSuccess: true,
    data: [],
  })
  mockGetRepositoryAccessOptions.mockResolvedValue({
    isSuccess: true,
    data: {
      users: [{ id: 1, email: "first@example.com", name: "First User" }],
      roles: [{ id: 2, name: "staff" }],
      nextUserOffset: 50,
    },
  })
})

describe("RepositoryAccessEditor", () => {
  it("searches and pages user grant candidates", async () => {
    render(<RepositoryAccessEditor repositoryId={7} isPublic={false} />)

    await waitFor(() =>
      expect(mockGetRepositoryAccessOptions).toHaveBeenCalledWith(7, "", 0)
    )

    mockGetRepositoryAccessOptions.mockResolvedValueOnce({
      isSuccess: true,
      data: {
        users: [{ id: 51, email: "alice@example.com", name: "Alice User" }],
        roles: [{ id: 2, name: "staff" }],
        nextUserOffset: 50,
      },
    })
    fireEvent.change(await screen.findByLabelText("Search users to grant"), {
      target: { value: "alice" },
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Search users" })
    )

    await waitFor(() =>
      expect(mockGetRepositoryAccessOptions).toHaveBeenCalledWith(
        7,
        "alice",
        0
      )
    )

    mockGetRepositoryAccessOptions.mockResolvedValueOnce({
      isSuccess: true,
      data: {
        users: [{ id: 52, email: "alice.two@example.com", name: "Alice Two" }],
        roles: [{ id: 2, name: "staff" }],
        nextUserOffset: null,
      },
    })
    fireEvent.click(
      screen.getByRole("button", { name: "Load more users" })
    )

    await waitFor(() =>
      expect(mockGetRepositoryAccessOptions).toHaveBeenCalledWith(
        7,
        "alice",
        50
      )
    )
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Load more users" })
      ).not.toBeInTheDocument()
    )
  })
})
