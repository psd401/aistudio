/** @jest-environment jsdom */

/**
 * The admin OAuth surface was create/list/revoke only, and the actions column
 * rendered nothing once a client was inactive. A client revoked *because* its
 * redirect list was wrong was therefore unrecoverable from the UI — which is
 * exactly what happened to the PSD OpenClaw client on 2026-08-10.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { EditRedirectUrisDialog } from "@/app/(protected)/admin/oauth-clients/_components/edit-redirect-uris-dialog"
import { updateOAuthClientRedirectUris } from "@/actions/oauth/oauth-client.actions"

jest.mock("@/actions/oauth/oauth-client.actions", () => ({
  updateOAuthClientRedirectUris: jest.fn(),
}))
jest.mock("@/lib/meridian/fonts", () => ({ meridianPortalClassName: "" }))
jest.mock("lucide-react", () => ({ Pencil: () => <span>edit</span> }))
jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    "aria-label": ariaLabel,
  }: {
    children: ReactNode
    onClick?: () => void
    disabled?: boolean
    "aria-label"?: string
  }) => (
    <button onClick={onClick} disabled={disabled} aria-label={ariaLabel}>
      {children}
    </button>
  ),
}))
jest.mock("@/components/ui/label", () => ({
  Label: ({ children }: { children: ReactNode }) => <label>{children}</label>,
}))
jest.mock("@/components/ui/textarea", () => ({
  Textarea: ({
    value,
    onChange,
  }: {
    value: string
    onChange: (e: { target: { value: string } }) => void
  }) => (
    <textarea
      aria-label="uris"
      value={value}
      onChange={(e) => onChange({ target: { value: e.target.value } })}
    />
  ),
}))
jest.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
  }: {
    checked?: boolean
    onCheckedChange?: (c: boolean) => void
  }) => (
    <input
      type="checkbox"
      aria-label="reactivate"
      checked={!!checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
    />
  ),
}))
// Render the dialog inline so the content is always present.
jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}))

const mockUpdate = updateOAuthClientRedirectUris as jest.MockedFunction<
  typeof updateOAuthClientRedirectUris
>

const revokedClient = {
  id: 1,
  clientId: "7e8646f4-4091-4a34-a6b9-0d3721e8a126",
  clientName: "PSD OpenClaw",
  applicationType: "native" as const,
  redirectUris: [
    "http://localhost:3000/agent-connect-aistudio/callback",
    "https://aistudio.psd401.ai/agent-connect-aistudio/callback",
  ],
  allowedScopes: ["openid"],
  grantTypes: ["authorization_code"],
  tokenEndpointAuthMethod: "none",
  requirePkce: true,
  isActive: false,
  isFirstParty: true,
  accessTokenTtl: 3600,
  refreshTokenTtl: 2592000,
  createdAt: new Date("2026-07-29T00:00:00.000Z"),
  updatedAt: new Date("2026-08-10T23:18:08.000Z"),
}

describe("EditRedirectUrisDialog", () => {
  beforeEach(() => jest.clearAllMocks())

  it("is available on a REVOKED client and offers reactivation", () => {
    render(<EditRedirectUrisDialog client={revokedClient} onSaved={() => {}} />)
    expect(screen.getByLabelText("uris")).toHaveValue(
      revokedClient.redirectUris.join("\n")
    )
    expect(screen.getByLabelText("reactivate")).toBeChecked()
  })

  it("saves the corrected URI list and reactivates in one call", async () => {
    mockUpdate.mockResolvedValue({
      isSuccess: true,
      message: "ok",
      data: { clientId: revokedClient.clientId, redirectUris: [] },
    })
    const onSaved = jest.fn()
    render(<EditRedirectUrisDialog client={revokedClient} onSaved={onSaved} />)

    fireEvent.change(screen.getByLabelText("uris"), {
      target: {
        value:
          "http://127.0.0.1:3000/agent-connect-aistudio/callback\nhttps://aistudio.psd401.ai/agent-connect-aistudio/callback",
      },
    })
    fireEvent.click(screen.getByText("Save"))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    expect(mockUpdate).toHaveBeenCalledWith({
      clientId: revokedClient.clientId,
      redirectUris: [
        "http://127.0.0.1:3000/agent-connect-aistudio/callback",
        "https://aistudio.psd401.ai/agent-connect-aistudio/callback",
      ],
      isActive: true,
    })
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it("shows the validator's message verbatim so the admin can fix the URI", async () => {
    mockUpdate.mockResolvedValue({
      isSuccess: false,
      message:
        "http://localhost:3000/cb: native HTTP redirect URIs must use literal 127.0.0.1 or [::1]",
    })
    const onSaved = jest.fn()
    render(<EditRedirectUrisDialog client={revokedClient} onSaved={onSaved} />)
    fireEvent.click(screen.getByText("Save"))

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "must use literal 127.0.0.1"
      )
    )
    expect(onSaved).not.toHaveBeenCalled()
  })

  it("drops blank lines rather than submitting empty URIs", async () => {
    mockUpdate.mockResolvedValue({
      isSuccess: true,
      message: "ok",
      data: { clientId: revokedClient.clientId, redirectUris: [] },
    })
    render(<EditRedirectUrisDialog client={revokedClient} onSaved={() => {}} />)
    fireEvent.change(screen.getByLabelText("uris"), {
      target: { value: "\n  https://a.example/cb  \n\n" },
    })
    fireEvent.click(screen.getByText("Save"))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalled())
    expect(mockUpdate.mock.calls[0][0].redirectUris).toEqual([
      "https://a.example/cb",
    ])
  })
})
