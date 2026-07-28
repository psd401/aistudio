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
    AlertDialogAction: PassThrough,
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
  Switch: () => <button type="button">Memory toggle</button>,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { MemoryTab } from "@/app/(protected)/settings/_components/memory-tab"
import type { NexusMemoryListItem } from "@/actions/nexus/memory.actions"

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
  it("caps select-all and manual selection at the server limit", () => {
    render(
      <MemoryTab
        initialData={{
          memories: Array.from({ length: 101 }, (_, index) =>
            memory(index + 1),
          ),
          memoryEnabled: true,
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
})
