jest.mock("@/actions/nexus/memory-import.actions", () => ({
  extractImportCandidates: jest.fn(),
  saveImportedMemories: jest.fn(),
}))

jest.mock("lucide-react", () => ({
  Loader2: () => <span aria-hidden="true" />,
}))

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
  },
}))

jest.mock("@/lib/client-logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

jest.mock("@/components/ui/dialog", () => {
  const PassThrough = ({
    children,
  }: {
    children?: import("react").ReactNode
  }) => <>{children}</>
  const Root = ({
    open,
    children,
  }: {
    open?: boolean
    children?: import("react").ReactNode
  }) => (open ? <>{children}</> : null)
  return {
    Dialog: Root,
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
    "data-testid": testId,
    onCheckedChange,
  }: {
    checked?: boolean
    disabled?: boolean
    "aria-label"?: string
    "data-testid"?: string
    onCheckedChange?: (checked: boolean) => void
  }) => (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
    />
  ),
}))

jest.mock("@/components/ui/select", () => {
  const PassThrough = ({
    children,
  }: {
    children?: import("react").ReactNode
  }) => <>{children}</>
  return {
    Select: PassThrough,
    SelectContent: PassThrough,
    SelectItem: PassThrough,
    SelectTrigger: PassThrough,
    SelectValue: () => null,
  }
})

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import {
  extractImportCandidates,
  saveImportedMemories,
} from "@/actions/nexus/memory-import.actions"
import { MemoryImportDialog } from "@/app/(protected)/settings/_components/memory-import-dialog"

describe("Settings memory import dialog", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("preserves the pasted response when extraction fails", async () => {
    jest.mocked(extractImportCandidates).mockResolvedValueOnce({
      isSuccess: false,
      message:
        "Failed to extract memories. Your pasted text was not changed.",
    })
    const pastedText = "- I prefer concise answers"

    render(
      <MemoryImportDialog
        open
        onOpenChange={jest.fn()}
        onImported={jest.fn()}
      />,
    )
    const textarea = screen.getByTestId("memory-import-paste")
    fireEvent.change(textarea, { target: { value: pastedText } })
    fireEvent.click(screen.getByTestId("memory-import-extract"))

    await waitFor(() =>
      expect(screen.getByTestId("memory-import-error")).toHaveTextContent(
        "Your pasted text was not changed",
      ),
    )
    expect(textarea).toHaveValue(pastedText)
    expect(saveImportedMemories).not.toHaveBeenCalled()
  })

  it("saves edited selected candidates only after review confirmation", async () => {
    jest.mocked(extractImportCandidates).mockResolvedValueOnce({
      isSuccess: true,
      message: "3 memory candidates ready to review",
      data: {
        candidates: [
          { content: "Original first fact", category: "profile" },
          { content: "Deselected fact", category: "context" },
          { content: "Third fact", category: "preference" },
        ],
      },
    })
    jest.mocked(saveImportedMemories).mockResolvedValueOnce({
      isSuccess: true,
      message: "2 memories imported",
      data: {
        total: 2,
        successful: 2,
        failed: 0,
        results: [
          {
            index: 0,
            status: "saved",
            memoryId: "11111111-1111-4111-8111-111111111111",
            action: "inserted",
          },
          {
            index: 1,
            status: "saved",
            memoryId: "33333333-3333-4333-8333-333333333333",
            action: "inserted",
          },
        ],
      },
    })
    const onImported = jest.fn().mockResolvedValue(undefined)
    const onOpenChange = jest.fn()

    render(
      <MemoryImportDialog
        open
        onOpenChange={onOpenChange}
        onImported={onImported}
      />,
    )
    fireEvent.change(screen.getByTestId("memory-import-paste"), {
      target: { value: "- Three facts" },
    })
    fireEvent.click(screen.getByTestId("memory-import-extract"))

    await waitFor(() =>
      expect(screen.getAllByTestId("memory-import-candidate")).toHaveLength(
        3,
      ),
    )
    expect(saveImportedMemories).not.toHaveBeenCalled()

    fireEvent.change(
      screen.getByTestId("memory-import-candidate-content-0"),
      { target: { value: "Edited first fact" } },
    )
    fireEvent.click(
      screen.getByTestId("memory-import-candidate-select-1"),
    )
    fireEvent.click(screen.getByTestId("memory-import-save"))

    await waitFor(() =>
      expect(saveImportedMemories).toHaveBeenCalledWith({
        vendor: "chatgpt",
        candidates: [
          { content: "Edited first fact", category: "profile" },
          { content: "Third fact", category: "preference" },
        ],
      }),
    )
    expect(onImported).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
