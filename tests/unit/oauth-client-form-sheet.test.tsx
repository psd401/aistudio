/** @jest-environment jsdom */

import { render, screen, within } from "@testing-library/react"
import type { ReactNode } from "react"
import { ClientFormSheet } from "@/app/(protected)/admin/oauth-clients/_components/client-form-sheet"

jest.mock("@/actions/oauth/oauth-client.actions", () => ({
  createOAuthClient: jest.fn(),
}))
jest.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}))
jest.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    disabled,
  }: {
    checked?: boolean
    disabled?: boolean
  }) => (
    <input type="checkbox" checked={checked} disabled={disabled} readOnly />
  ),
}))
jest.mock("@/components/ui/input", () => ({
  Input: () => <input />,
}))
jest.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children: ReactNode }) => <label>{children}</label>,
}))
jest.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({
    children,
    id,
  }: {
    children: ReactNode
    id?: string
  }) => <button id={id}>{children}</button>,
  SelectValue: () => null,
}))

describe("OAuth client registration form", () => {
  it("shows and locks the required OIDC scopes for a public client", () => {
    render(<ClientFormSheet onSuccess={jest.fn()} />)

    for (const scope of ["openid", "profile", "offline_access"]) {
      const row = screen.getByText(scope, { exact: true }).closest("label")
      expect(row).not.toBeNull()
      expect(within(row as HTMLLabelElement).getByRole("checkbox")).toBeChecked()
      expect(
        within(row as HTMLLabelElement).getByRole("checkbox")
      ).toBeDisabled()
      expect(row).toHaveTextContent("required for public clients")
    }

    const emailRow = screen.getByText("email", { exact: true }).closest("label")
    expect(emailRow).not.toBeNull()
    expect(
      within(emailRow as HTMLLabelElement).getByRole("checkbox")
    ).toBeEnabled()
  })
})
