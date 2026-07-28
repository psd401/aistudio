import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { SettingsClient } from "@/app/(protected)/settings/_components/settings-client"

jest.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  TabsContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))

jest.mock("@/app/(protected)/settings/_components/profile-tab", () => ({
  ProfileTab: () => <div>Profile content</div>,
}))
jest.mock("@/app/(protected)/settings/_components/api-keys-tab", () => ({
  ApiKeysTab: () => <div>API key content</div>,
}))
jest.mock("@/app/(protected)/settings/_components/preferences-tab", () => ({
  PreferencesTab: () => <div>Preference content</div>,
}))
jest.mock("@/app/(protected)/settings/_components/memory-tab", () => ({
  MemoryTab: () => <div>Memory content</div>,
}))

const BASE_PROPS = {
  profileData: null,
  apiKeys: [],
  nexusPreferences: {
    mode: "standard" as const,
    family: "auto" as const,
  },
  memoryData: {
    memories: [],
    memoryEnabled: true,
    globalMemoryEnabled: true,
    nextCursor: null,
  },
  memoryLoadError: null,
}

describe("Settings memory capability visibility", () => {
  it("renders the Memory tab for a capability-granted user", () => {
    render(<SettingsClient {...BASE_PROPS} hasMemoryCapability />)

    expect(screen.getByRole("button", { name: "Memory" })).toBeInTheDocument()
    expect(screen.getByText("Memory content")).toBeInTheDocument()
  })

  it("hides the Memory tab without the capability", () => {
    render(<SettingsClient {...BASE_PROPS} hasMemoryCapability={false} />)

    expect(
      screen.queryByRole("button", { name: "Memory" }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText("Memory content")).not.toBeInTheDocument()
  })
})
