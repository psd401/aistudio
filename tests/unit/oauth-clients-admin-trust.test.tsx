/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { OAuthClientsPageClient } from "@/app/(protected)/admin/oauth-clients/_components/oauth-clients-page-client"
import type { OAuthClientRow } from "@/actions/oauth/oauth-client.actions"

jest.mock("@/actions/oauth/oauth-client.actions", () => ({
  listOAuthClients: jest.fn(),
  revokeOAuthClient: jest.fn(),
}))
jest.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}))
jest.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}))
jest.mock("@/components/ui/table", () => ({
  Table: ({ children }: { children: ReactNode }) => (
    <table>{children}</table>
  ),
  TableBody: ({ children }: { children: ReactNode }) => (
    <tbody>{children}</tbody>
  ),
  TableCell: ({ children }: { children: ReactNode }) => <td>{children}</td>,
  TableHead: ({ children }: { children: ReactNode }) => <th>{children}</th>,
  TableHeader: ({ children }: { children: ReactNode }) => (
    <thead>{children}</thead>
  ),
  TableRow: ({ children }: { children: ReactNode }) => <tr>{children}</tr>,
}))
jest.mock("lucide-react", () => ({
  Plus: () => <span aria-hidden="true">+</span>,
  Ban: () => <span aria-hidden="true">×</span>,
}))
jest.mock(
  "@/app/(protected)/admin/oauth-clients/_components/client-form-sheet",
  () => ({
    ClientFormSheet: () => null,
  })
)
jest.mock("@/components/ui/sheet", () => {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  )
  return {
    Sheet: Wrapper,
    SheetContent: Wrapper,
    SheetDescription: Wrapper,
    SheetHeader: Wrapper,
    SheetTitle: Wrapper,
    SheetTrigger: Wrapper,
  }
})
jest.mock("@/components/ui/alert-dialog", () => {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  )
  return {
    AlertDialog: Wrapper,
    AlertDialogAction: Wrapper,
    AlertDialogCancel: Wrapper,
    AlertDialogContent: Wrapper,
    AlertDialogDescription: Wrapper,
    AlertDialogFooter: Wrapper,
    AlertDialogHeader: Wrapper,
    AlertDialogTitle: Wrapper,
    AlertDialogTrigger: Wrapper,
  }
})

function client(
  id: number,
  clientName: string,
  isFirstParty: boolean
): OAuthClientRow {
  const now = new Date("2026-07-24T12:00:00.000Z")
  return {
    id,
    clientId: `client-${id}`,
    clientName,
    applicationType: "native",
    redirectUris: ["org.example:/oauth/callback"],
    allowedScopes: ["openid"],
    grantTypes: ["authorization_code", "refresh_token"],
    tokenEndpointAuthMethod: "none",
    requirePkce: true,
    accessTokenTtl: 900,
    refreshTokenTtl: 86400,
    isActive: true,
    isFirstParty,
    createdAt: now,
    updatedAt: now,
  }
}

describe("OAuth client trust administration", () => {
  it("makes privileged first-party state visible in the admin list", () => {
    render(
      <OAuthClientsPageClient
        initialClients={[
          client(1, "Atrium Capture Mac", true),
          client(2, "External App", false),
        ]}
      />
    )

    expect(screen.getByText("Atrium Capture Mac")).toBeInTheDocument()
    expect(screen.getByText("First-party")).toBeInTheDocument()
    expect(screen.getByText("External App")).toBeInTheDocument()
    expect(screen.getByText("Standard")).toBeInTheDocument()
  })
})
