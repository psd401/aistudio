import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import DocumentUploadButton from "@/components/ui/document-upload-button"

const mockUploadTemporaryAttachment = jest.fn()
const mockWaitForTemporaryAttachment = jest.fn()
const mockUploadViaServer = jest.fn()
const mockToastError = jest.fn()

jest.mock("@/lib/repositories/temporary-attachment-client", () => ({
  uploadTemporaryAttachment: (...args: unknown[]) =>
    mockUploadTemporaryAttachment(...args),
  waitForTemporaryAttachment: (...args: unknown[]) =>
    mockWaitForTemporaryAttachment(...args),
}))
jest.mock("@/components/ui/utils/document-upload-helpers", () => ({
  uploadViaServer: (...args: unknown[]) => mockUploadViaServer(...args),
  formatDocumentTag: jest.fn(),
  getButtonText: (
    _status: string,
    _loading: boolean,
    _fileName: string | null,
    label: string
  ) => label,
  SUPPORTED_FILE_TYPES: ["text/plain"],
  MAX_FILE_SIZE: 50 * 1024 * 1024,
}))
jest.mock("@/components/ui/hooks/use-document-upload-polling", () => ({
  useDocumentUploadPolling: () => ({
    startPolling: jest.fn(),
    cancelPolling: jest.fn(),
  }),
}))
jest.mock("@/lib/utils/uuid", () => ({
  generateUUID: () => "123e4567-e89b-42d3-a456-426614174000",
}))
jest.mock("@/lib/client-logger", () => ({
  createLogger: () => ({ error: jest.fn() }),
}))
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: jest.fn(),
  },
}))
jest.mock("lucide-react", () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />
  return {
    CheckCircle: Icon,
    FileUp: Icon,
    Loader2: Icon,
  }
})

describe("DocumentUploadButton repository-only mode", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("fails closed instead of calling the historical converter on flag-off", async () => {
    mockUploadTemporaryAttachment.mockResolvedValue({ mode: "legacy" })
    const onError = jest.fn()
    const { container } = render(
      <DocumentUploadButton
        repositoryBacked
        onContent={jest.fn()}
        onError={onError}
      />
    )

    fireEvent.click(
      screen.getByRole("button", { name: "Add Document for Knowledge" })
    )
    const fileInput = container.querySelector<HTMLInputElement>(
      'input[type="file"]'
    )
    expect(fileInput).not.toBeNull()
    fireEvent.change(fileInput!, {
      target: {
        files: [new File(["source"], "notes.txt", { type: "text/plain" })],
      },
    })

    await waitFor(() =>
      expect(mockUploadTemporaryAttachment).toHaveBeenCalledTimes(1)
    )
    expect(mockUploadViaServer).not.toHaveBeenCalled()
    expect(mockWaitForTemporaryAttachment).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("Repository Manager"),
      })
    )
    expect(mockToastError).toHaveBeenCalledWith(
      expect.stringContaining("Repository Manager")
    )
  })
})
