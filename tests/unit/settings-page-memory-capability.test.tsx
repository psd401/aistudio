/* eslint-disable no-var */
var mockGetNexusChatPreferences = jest.fn()
var mockGetUserProfile = jest.fn()
var mockListUserApiKeys = jest.fn()
var mockListNexusMemories = jest.fn()
var mockHasCapabilityAccess = jest.fn()
var mockLogError = jest.fn()
/* eslint-enable no-var */

jest.mock("@/actions/settings/user-settings.actions", () => ({
  getNexusChatPreferences: (...args: unknown[]) =>
    mockGetNexusChatPreferences(...args),
  getUserProfile: (...args: unknown[]) => mockGetUserProfile(...args),
  listUserApiKeys: (...args: unknown[]) => mockListUserApiKeys(...args),
}))

jest.mock("@/actions/nexus/memory.actions", () => ({
  listNexusMemories: (...args: unknown[]) => mockListNexusMemories(...args),
}))

jest.mock("@/utils/roles", () => ({
  hasCapabilityAccess: (...args: unknown[]) =>
    mockHasCapabilityAccess(...args),
}))

jest.mock("@/lib/logger", () => ({
  createLogger: () => ({
    error: (...args: unknown[]) => mockLogError(...args),
  }),
}))

jest.mock("@/components/ui/page-branding", () => ({
  PageBranding: () => <div>Page branding</div>,
}))

jest.mock(
  "@/app/(protected)/settings/_components/settings-client",
  () => ({
    SettingsClient: ({
      hasMemoryCapability,
      profileData,
    }: {
      hasMemoryCapability: boolean
      profileData: { email: string } | null
    }) => (
      <div>
        <span data-testid="memory-capability">
          {String(hasMemoryCapability)}
        </span>
        <span data-testid="profile-email">{profileData?.email}</span>
      </div>
    ),
  }),
)

import { render, screen } from "@testing-library/react"
import SettingsPage from "@/app/(protected)/settings/page"

describe("Settings page memory capability failure", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetUserProfile.mockResolvedValue({
      isSuccess: true,
      message: "Loaded",
      data: { email: "user@example.com" },
    })
    mockListUserApiKeys.mockResolvedValue({
      isSuccess: true,
      message: "Loaded",
      data: [],
    })
    mockGetNexusChatPreferences.mockResolvedValue({
      isSuccess: true,
      message: "Loaded",
      data: { mode: "standard", family: "auto" },
    })
  })

  it("hides Memory while keeping other settings available", async () => {
    mockHasCapabilityAccess.mockRejectedValue(
      new Error("Capability database unavailable"),
    )

    render(await SettingsPage())

    expect(screen.getByTestId("memory-capability")).toHaveTextContent("false")
    expect(screen.getByTestId("profile-email")).toHaveTextContent(
      "user@example.com",
    )
    expect(mockListNexusMemories).not.toHaveBeenCalled()
    expect(mockLogError).toHaveBeenCalledWith(
      "Failed to resolve Nexus memory capability",
      { error: "Capability database unavailable" },
    )
  })
})
