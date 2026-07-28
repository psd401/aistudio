jest.mock("@/actions/nexus/memory.actions", () => ({
  addNexusMemory: jest.fn(),
  bulkDeleteNexusMemories: jest.fn(),
  deleteNexusMemory: jest.fn(),
  listNexusMemories: jest.fn(),
  setNexusMemoryEnabled: jest.fn(),
  updateNexusMemory: jest.fn(),
}))

jest.mock("lucide-react", () => {
  const Icon = () => <span aria-hidden="true" />
  return {
    Brain: Icon,
    Loader2: Icon,
    Pencil: Icon,
    Plus: Icon,
    Trash2: Icon,
    Upload: Icon,
    X: Icon,
  }
})

jest.mock("@/components/ui/alert-dialog", () => {
  const PassThrough = ({
    children,
  }: {
    children?: import("react").ReactNode
  }) => <>{children}</>
  const ClosedRoot = ({
    open,
    children,
  }: {
    open?: boolean
    children?: import("react").ReactNode
  }) => (open ? <>{children}</> : null)
  return {
    AlertDialog: ClosedRoot,
    AlertDialogAction: ({
      children,
      disabled,
      onClick,
      "data-testid": testId,
    }: {
      children?: import("react").ReactNode
      disabled?: boolean
      onClick?: import("react").MouseEventHandler<HTMLButtonElement>
      "data-testid"?: string
    }) => (
      <button
        type="button"
        disabled={disabled}
        data-testid={testId}
        onClick={onClick}
      >
        {children}
      </button>
    ),
    AlertDialogCancel: PassThrough,
    AlertDialogContent: PassThrough,
    AlertDialogDescription: PassThrough,
    AlertDialogFooter: PassThrough,
    AlertDialogHeader: PassThrough,
    AlertDialogTitle: PassThrough,
  }
})

jest.mock("@/components/ui/dialog", () => {
  const PassThrough = ({
    children,
  }: {
    children?: import("react").ReactNode
  }) => <>{children}</>
  const ClosedRoot = ({
    open,
    children,
  }: {
    open?: boolean
    children?: import("react").ReactNode
  }) => (open ? <>{children}</> : null)
  return {
    Dialog: ClosedRoot,
    DialogContent: PassThrough,
    DialogDescription: PassThrough,
    DialogFooter: PassThrough,
    DialogHeader: PassThrough,
    DialogTitle: PassThrough,
  }
})

jest.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    disabled,
    "aria-label": ariaLabel,
    onCheckedChange,
  }: {
    checked?: boolean
    disabled?: boolean
    "aria-label"?: string
    onCheckedChange?: (checked: boolean) => void
  }) => (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
    />
  ),
}))

jest.mock("@/components/ui/switch", () => ({
  Switch: ({
    disabled,
    "aria-label": ariaLabel,
  }: {
    disabled?: boolean
    "aria-label"?: string
  }) => (
    <button type="button" disabled={disabled} aria-label={ariaLabel}>
      Memory toggle
    </button>
  ),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryTab } from "@/app/(protected)/settings/_components/memory-tab"
import {
  deleteNexusMemory,
  listNexusMemories,
  type NexusMemoryListItem,
} from "@/actions/nexus/memory.actions"

function memory(index: number): NexusMemoryListItem {
  const timestamp = "2026-07-28T12:00:00.000Z"
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    content: `Memory ${index}`,
    category: "context",
    source: "manual",
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

describe("Settings memory bulk selection", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("caps select-all and manual selection at the server limit", () => {
    render(
      <MemoryTab
        initialData={{
          memories: Array.from({ length: 101 }, (_, index) =>
            memory(index + 1),
          ),
          memoryEnabled: true,
          globalMemoryEnabled: true,
          nextCursor: null,
        }}
      />,
    )

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Select memories for bulk deletion",
      }),
    )

    expect(screen.getByText("100 selected (maximum)")).toBeInTheDocument()
    expect(
      screen.getByRole("checkbox", {
        name: "Select memory: Memory 1",
      }),
    ).toBeChecked()
    expect(
      screen.getByRole("checkbox", {
        name: "Select memory: Memory 101",
      }),
    ).toBeDisabled()
  })

  it("disables write controls and the account toggle under the global kill switch", () => {
    render(
      <MemoryTab
        initialData={{
          memories: [memory(1)],
          memoryEnabled: true,
          globalMemoryEnabled: false,
          nextCursor: null,
        }}
      />,
    )

    expect(screen.getByTestId("memory-global-disabled")).toHaveTextContent(
      "disabled by an administrator",
    )
    expect(screen.getByTestId("memory-add-open")).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Edit memory: Memory 1" }),
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Delete memory: Memory 1" }),
    ).toBeEnabled()
    expect(
      screen.getByRole("button", { name: "Enable Nexus memory" }),
    ).toBeDisabled()
  })

  it("disables add and edit while the account memory toggle is off", () => {
    render(
      <MemoryTab
        initialData={{
          memories: [memory(1)],
          memoryEnabled: false,
          globalMemoryEnabled: true,
          nextCursor: null,
        }}
      />,
    )

    expect(screen.getByTestId("memory-add-open")).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Edit memory: Memory 1" }),
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Enable Nexus memory" }),
    ).toBeEnabled()
  })
})

describe("Settings memory collection resilience", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("loads the next bounded page without duplicating existing rows", async () => {
    const cursor = {
      updatedAtMicros: "1785254400000000",
      id: memory(1).id,
    }
    jest.mocked(listNexusMemories).mockResolvedValueOnce({
      isSuccess: true,
      message: "Loaded",
      data: {
        memories: [memory(1), memory(2)],
        memoryEnabled: true,
        globalMemoryEnabled: true,
        nextCursor: null,
      },
    })
    render(
      <MemoryTab
        initialData={{
          memories: [memory(1)],
          memoryEnabled: true,
          globalMemoryEnabled: true,
          nextCursor: cursor,
        }}
      />,
    )

    fireEvent.click(screen.getByTestId("memory-load-more"))

    await waitFor(() =>
      expect(screen.getByText("Memory 2")).toBeInTheDocument(),
    )
    expect(listNexusMemories).toHaveBeenCalledWith({ cursor })
    expect(screen.getAllByTestId("memory-row")).toHaveLength(2)
    expect(screen.queryByTestId("memory-load-more")).not.toBeInTheDocument()
  })

  it("retries an explicit initial-load error instead of showing disabled defaults", async () => {
    jest.mocked(listNexusMemories).mockResolvedValueOnce({
      isSuccess: true,
      message: "Loaded",
      data: {
        memories: [memory(1)],
        memoryEnabled: true,
        globalMemoryEnabled: true,
        nextCursor: null,
      },
    })
    render(
      <MemoryTab
        initialData={null}
        initialError="Failed to load memories"
      />,
    )

    expect(screen.getByTestId("memory-load-error")).toHaveTextContent(
      "Memories could not be loaded",
    )
    expect(
      screen.queryByTestId("memory-global-disabled"),
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("memory-retry"))

    await waitFor(() =>
      expect(screen.getByText("Memory 1")).toBeInTheDocument(),
    )
    expect(screen.queryByTestId("memory-load-error")).not.toBeInTheDocument()
  })

  it("keeps a committed deletion successful when the refresh fails", async () => {
    jest.mocked(deleteNexusMemory).mockResolvedValueOnce({
      isSuccess: true,
      message: "Memory deleted",
      data: { memoryId: memory(1).id },
    })
    jest.mocked(listNexusMemories).mockResolvedValueOnce({
      isSuccess: false,
      message: "Failed to load memories",
    })
    render(
      <MemoryTab
        initialData={{
          memories: [memory(1)],
          memoryEnabled: true,
          globalMemoryEnabled: true,
          nextCursor: null,
        }}
      />,
    )

    fireEvent.click(
      screen.getByRole("button", { name: "Delete memory: Memory 1" }),
    )
    fireEvent.click(screen.getByTestId("memory-delete-confirm"))

    await waitFor(() =>
      expect(screen.queryByText("Memory 1")).not.toBeInTheDocument(),
    )
    expect(deleteNexusMemory).toHaveBeenCalledWith(memory(1).id)
    expect(listNexusMemories).toHaveBeenCalled()
  })

  it("keeps the confirmation open when deletion fails", async () => {
    jest.mocked(deleteNexusMemory).mockResolvedValueOnce({
      isSuccess: false,
      message: "Failed to delete memory",
    })
    render(
      <MemoryTab
        initialData={{
          memories: [memory(1)],
          memoryEnabled: true,
          globalMemoryEnabled: true,
          nextCursor: null,
        }}
      />,
    )

    fireEvent.click(
      screen.getByRole("button", { name: "Delete memory: Memory 1" }),
    )
    const confirm = screen.getByTestId("memory-delete-confirm")

    expect(fireEvent.click(confirm)).toBe(false)
    await waitFor(() =>
      expect(deleteNexusMemory).toHaveBeenCalledWith(memory(1).id),
    )
    expect(screen.getByTestId("memory-delete-confirm")).toBeEnabled()
    expect(screen.getByText("Memory 1")).toBeInTheDocument()
  })
})
