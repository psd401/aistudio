import { fireEvent, render, screen } from "@testing-library/react"
import { RepositorySourcePicker } from "@/components/features/repositories/repository-source-picker"

jest.mock(
  "@/components/features/repositories/repository-picker",
  () => ({
    RepositoryPicker: ({
      onSelectionChange,
    }: {
      onSelectionChange: (ids: number[]) => void
    }) => (
      <button onClick={() => onSelectionChange([73])}>
        Select destination
      </button>
    ),
  })
)
jest.mock(
  "@/components/features/repositories/file-upload-modal",
  () => ({
    FileUploadModal: ({
      repositoryId,
      onSuccess,
    }: {
      repositoryId: number
      onSuccess: () => void
    }) => (
      <button onClick={onSuccess}>
        {`Upload to repository ${repositoryId}`}
      </button>
    ),
  })
)

describe("RepositorySourcePicker", () => {
  it("reports the selected destination after a successful upload", () => {
    const onSuccess = jest.fn()
    render(
      <RepositorySourcePicker
        open
        onOpenChange={jest.fn()}
        onSuccess={onSuccess}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "Select destination" }))
    fireEvent.click(
      screen.getByRole("button", { name: "Upload to repository 73" })
    )

    expect(onSuccess).toHaveBeenCalledWith(73)
  })

  it("uses a provided destination without showing repository selection", () => {
    const onSuccess = jest.fn()
    render(
      <RepositorySourcePicker
        repositoryId={15}
        open
        onOpenChange={jest.fn()}
        onSuccess={onSuccess}
      />
    )

    expect(
      screen.queryByRole("button", { name: "Select destination" })
    ).not.toBeInTheDocument()
    fireEvent.click(
      screen.getByRole("button", { name: "Upload to repository 15" })
    )
    expect(onSuccess).toHaveBeenCalledWith(15)
  })
})
