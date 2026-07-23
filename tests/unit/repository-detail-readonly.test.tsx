import { render, screen } from "@testing-library/react"
import { RepositoryDetail } from "@/components/features/repositories/repository-detail"
import type { Repository } from "@/actions/repositories/repository.actions"

jest.mock(
  "@/components/features/repositories/repository-item-list",
  () => ({
    RepositoryItemList: ({ canManage }: { canManage: boolean }) => (
      <div>{canManage ? "item-manager" : "item-reader"}</div>
    ),
  })
)
jest.mock(
  "@/components/features/repositories/repository-access-editor",
  () => ({
    RepositoryAccessEditor: () => <div>access-editor</div>,
  })
)
jest.mock(
  "@/components/features/repositories/repository-source-picker",
  () => ({
    RepositorySourcePicker: () => <div>source-picker</div>,
  })
)
jest.mock(
  "@/components/features/repositories/repository-search",
  () => ({
    RepositorySearch: () => <div>repository-search</div>,
  })
)
jest.mock("lucide-react", () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />
  return {
    ArrowLeft: Icon,
    Edit: Icon,
    Globe: Icon,
    Lock: Icon,
    Search: Icon,
    Settings: Icon,
    Shield: Icon,
  }
})
jest.mock("@/components/ui/tabs", () => {
  const React = require("react")
  const pass =
    (tag: string) =>
    ({ children }: { children?: React.ReactNode }) =>
      React.createElement(tag, null, children)
  return {
    Tabs: pass("div"),
    TabsContent: pass("div"),
    TabsList: pass("div"),
    TabsTrigger: pass("button"),
  }
})

function repository(canManage: boolean): Repository {
  return {
    id: 5,
    name: "Shared handbook",
    description: "Team guidance",
    ownerId: 1,
    isPublic: false,
    repositoryKind: "durable",
    lifecycleStatus: "active",
    retentionDays: null,
    expiresAt: null,
    activeIndexGenerationId: "generation-1",
    metadata: {},
    createdAt: new Date("2026-07-20T12:00:00Z"),
    updatedAt: new Date("2026-07-23T12:00:00Z"),
    ownerName: "Owner",
    itemCount: 1,
    canManage,
  }
}

describe("RepositoryDetail authorization boundary", () => {
  it("renders shared readers without mutation or ACL controls", () => {
    render(<RepositoryDetail repository={repository(false)} />)

    expect(screen.getByText("Shared read only")).toBeInTheDocument()
    expect(screen.getByText("item-reader")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument()
    expect(screen.queryByText("access-editor")).not.toBeInTheDocument()
    expect(
      screen.getByText(/only its owner or an administrator can change/i)
    ).toBeInTheDocument()
  })

  it("renders mutation and ACL controls for managers", () => {
    render(<RepositoryDetail repository={repository(true)} />)

    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument()
    expect(screen.getByText("item-manager")).toBeInTheDocument()
    expect(screen.getByText("access-editor")).toBeInTheDocument()
  })
})
