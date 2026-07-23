import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { FileUploadModal } from "@/components/features/repositories/file-upload-modal"

const mockExecuteAction = jest.fn()
const mockToast = jest.fn()
const mockUploadFileToRepositoryStorage = jest.fn()
const mockFetch = jest.fn()

jest.mock("@/actions/repositories/repository-items.actions", () => ({
  addDocumentItem: jest.fn(),
  addDocumentWithPresignedUrl: jest.fn(),
  addUrlItem: jest.fn(),
  addTextItem: jest.fn(),
}))
jest.mock("@/lib/hooks/use-action", () => ({
  useAction: () => ({
    execute: mockExecuteAction,
    isPending: false,
  }),
}))
jest.mock("@/lib/repositories/content-platform/browser-upload", () => ({
  uploadFileToRepositoryStorage: (
    ...args: unknown[]
  ) => mockUploadFileToRepositoryStorage(...args),
}))
jest.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}))
jest.mock("@/components/ui/form", () => {
  const React = require("react")
  const {
    Controller,
    FormProvider,
  } = jest.requireActual("react-hook-form")
  const pass =
    (tag: string) =>
    ({ children }: { children?: React.ReactNode }) =>
      React.createElement(tag, null, children)
  return {
    Form: ({
      children,
      ...props
    }: {
      children?: React.ReactNode
    } & Record<string, unknown>) =>
      React.createElement(FormProvider, props, children),
    FormField: (props: Record<string, unknown>) =>
      React.createElement(Controller, props),
    FormItem: pass("div"),
    FormLabel: pass("span"),
    FormControl: ({ children }: { children?: React.ReactNode }) => children,
    FormDescription: pass("p"),
    FormMessage: () => null,
  }
})
jest.mock("lucide-react", () => {
  const Icon = (props: React.HTMLAttributes<HTMLSpanElement>) => (
    <span {...props} />
  )
  return {
    AlertCircle: Icon,
    CheckCircle2: Icon,
    Cloud: Icon,
    FileText: Icon,
    Info: Icon,
    Link: Icon,
    Loader2: Icon,
    Type: Icon,
    Upload: Icon,
    XCircle: Icon,
  }
})
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
    DialogHeader: pass("div"),
    DialogTitle: pass("h2"),
  }
})
jest.mock("@/components/ui/tabs", () => {
  const React = require("react")
  const TabContext = React.createContext("document")
  return {
    Tabs: ({
      value,
      children,
    }: {
      value: string
      children?: React.ReactNode
    }) => React.createElement(TabContext.Provider, { value }, children),
    TabsList: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children),
    TabsTrigger: ({
      children,
      disabled,
    }: {
      children?: React.ReactNode
      disabled?: boolean
    }) => React.createElement("button", { type: "button", disabled }, children),
    TabsContent: ({
      value,
      children,
    }: {
      value: string
      children?: React.ReactNode
    }) =>
      React.useContext(TabContext) === value
        ? React.createElement("div", null, children)
        : null,
  }
})

beforeEach(() => {
  jest.clearAllMocks()
  global.fetch = mockFetch as unknown as typeof fetch
  mockExecuteAction.mockResolvedValue({ isSuccess: true })
})

describe("FileUploadModal", () => {
  it("keeps the canonical direct-upload saga pending until completion", async () => {
    let resolveUpload:
      | ((parts: Array<{ ETag: string; PartNumber: number }>) => void)
      | undefined
    mockUploadFileToRepositoryStorage.mockImplementation(
      () =>
        new Promise<Array<{ ETag: string; PartNumber: number }>>((resolve) => {
          resolveUpload = resolve
        })
    )
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          mode: "canonical",
          upload: {
            sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            uploadMethod: "single",
            uploadUrl: "https://uploads.example.test/source",
            headers: {},
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      })

    const onOpenChange = jest.fn()
    const onSuccess = jest.fn()
    const { container } = render(
      <FileUploadModal
        repositoryId={7}
        open
        onOpenChange={onOpenChange}
        onSuccess={onSuccess}
      />
    )

    fireEvent.change(screen.getByPlaceholderText("e.g., User Manual"), {
      target: { value: "Release notes" },
    })
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]'
    )
    expect(fileInput).not.toBeNull()
    fireEvent.change(fileInput!, {
      target: {
        files: [
          new File(["notes"], "release-notes.txt", { type: "text/plain" }),
        ],
      },
    })
    fireEvent.click(screen.getByRole("button", { name: /Upload File/i }))

    await waitFor(() =>
      expect(mockUploadFileToRepositoryStorage).toHaveBeenCalledTimes(1)
    )
    expect(
      screen.getByRole("button", { name: /Upload File/i })
    ).toBeDisabled()
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled()
    expect(fileInput).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: /Upload File/i }))
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(onOpenChange).not.toHaveBeenCalled()

    await act(async () => {
      resolveUpload?.([])
    })

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(onSuccess).toHaveBeenCalledTimes(1)
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })
})
