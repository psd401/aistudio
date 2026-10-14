/** @jest-environment jsdom */

/**
 * One-time credential entry form (issue #1887).
 *
 * The page this renders exists so staff stop pasting API keys into chat, so
 * these tests pin the properties that make it a safe place to type a secret:
 * the field is masked, the value reaches the server action and nothing else,
 * and every refusal branch ends with the field gone rather than silently
 * re-offered.
 *
 * The E2E (tests/e2e/agent-credential-entry.spec.ts) drives the real page but
 * deliberately stops short of submitting a valid value — the broker writes to
 * AWS Secrets Manager. The success render is therefore pinned here.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { CredentialEntrySubmission } from "@/lib/agent-workspace/credential-entry"

const storeCredentialMock = jest.fn()
jest.mock("@/actions/agent-credential-entry.actions", () => ({
  storeCredentialFromEntryLink: (...args: unknown[]) =>
    storeCredentialMock(...args),
}))

import { CredentialEntryForm } from "@/app/agent-connect-credential/_components/credential-entry-form"

const TOKEN = "signed.consent.token"
const OWNER = "owner@psd401.net"
const CREDENTIAL = "freshservice_api_key"
const SECRET = "not-a-real-key"

function ok(outcome: CredentialEntrySubmission) {
  return { isSuccess: true as const, message: "ok", data: outcome }
}

function renderForm() {
  return render(
    <CredentialEntryForm
      token={TOKEN}
      credentialName={CREDENTIAL}
      ownerEmail={OWNER}
    />
  )
}

// Queried by test id, not by label: jest maps @radix-ui/react-label to a mock
// that renders a <div>, so the htmlFor/id association does not survive here.
// The real label association is asserted in the browser by the E2E
// (`page.getByLabel('Credential value')`).
function field(): HTMLInputElement {
  return screen.getByTestId("credential-entry-input") as HTMLInputElement
}

function submit(): void {
  fireEvent.click(screen.getByRole("button", { name: /save credential/i }))
}

beforeEach(() => {
  storeCredentialMock.mockReset()
})

describe("credential entry form — the input", () => {
  it("masks the value and does not offer it to a password manager", () => {
    renderForm()
    const input = field()
    expect(input.type).toBe("password")
    expect(input.getAttribute("autocomplete")).toBe("off")
  })

  it("names the credential readably AND by its raw slot name", () => {
    renderForm()
    // The raw slot name is what the agent said in chat, so it has to be here;
    // "Freshservice API Key" is what a non-developer will recognise.
    expect(screen.getByText(CREDENTIAL)).toBeInTheDocument()
    expect(screen.getAllByText(/Freshservice API Key/).length).toBeGreaterThan(0)
  })

  it("warns about the one-use 15-minute window BEFORE the field", () => {
    const { container } = renderForm()
    const warning = screen.getByText(/works once and expires 15 minutes/i)
    const input = screen.getByTestId("credential-entry-input")
    // The user leaves this page to fetch the key; a warning they only meet on
    // the way back is a warning that arrived too late.
    expect(
      warning.compareDocumentPosition(input) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(container).toBeTruthy()
  })

  it("will not submit an empty field", () => {
    renderForm()
    expect(screen.getByRole("button", { name: /save credential/i })).toBeDisabled()
  })

  it("sends the token and the value to the action and nothing else", async () => {
    storeCredentialMock.mockResolvedValue(
      ok({ status: "stored", credentialName: CREDENTIAL, action: "created" })
    )
    renderForm()
    fireEvent.change(field(), { target: { value: SECRET } })
    submit()
    await waitFor(() => expect(storeCredentialMock).toHaveBeenCalledTimes(1))
    expect(storeCredentialMock).toHaveBeenCalledWith(TOKEN, SECRET)
  })
})

describe("credential entry form — outcomes", () => {
  it("confirms a first-time store and clears the field", async () => {
    storeCredentialMock.mockResolvedValue(
      ok({ status: "stored", credentialName: CREDENTIAL, action: "created" })
    )
    renderForm()
    fireEvent.change(field(), { target: { value: SECRET } })
    submit()

    await waitFor(() =>
      expect(screen.getByText(/Credential saved/i)).toBeInTheDocument()
    )
    expect(screen.getByText(/stored securely/i)).toBeInTheDocument()
    // The field is gone, so the value cannot be resubmitted or read back.
    expect(screen.queryByTestId("credential-entry-input")).toBeNull()
    // And the success copy never contains the secret.
    expect(document.body.textContent).not.toContain(SECRET)
  })

  it("says 'updated' when the value replaced an existing one", async () => {
    storeCredentialMock.mockResolvedValue(
      ok({ status: "stored", credentialName: CREDENTIAL, action: "rotated" })
    )
    renderForm()
    fireEvent.change(field(), { target: { value: SECRET } })
    submit()

    await waitFor(() =>
      expect(screen.getByText(/updated/i)).toBeInTheDocument()
    )
  })

  it("keeps the form open with an inline error on an invalid value", async () => {
    storeCredentialMock.mockResolvedValue(
      ok({
        status: "invalid-value",
        credentialName: CREDENTIAL,
        reason: "That value is too short — credentials must be at least 8 characters.",
      })
    )
    renderForm()
    fireEvent.change(field(), { target: { value: "short" } })
    submit()

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/too short/i)
    )
    // The link is not spent on a typo, so the field must still be there...
    const input = field()
    expect(input).toBeInTheDocument()
    // ...with what they typed intact, and flagged for assistive tech.
    expect(input.value).toBe("short")
    expect(input).toHaveAttribute("aria-invalid", "true")
    expect(input).toHaveAttribute("aria-describedby", "credential-value-error")
    // ...and focus lands back on the thing that has to change. Waited for
    // because the focus effect only fires once the transition settles (the
    // input is disabled while the submit is in flight).
    await waitFor(() => expect(document.activeElement).toBe(field()))
  })

  it("explains a misconfigured deployment as our problem, not a bad link", async () => {
    storeCredentialMock.mockResolvedValue(ok({ status: "not-configured" }))
    renderForm()
    fireEvent.change(field(), { target: { value: SECRET } })
    submit()

    await waitFor(() =>
      expect(screen.getByText(/not set up to store credentials/i)).toBeInTheDocument()
    )
    expect(screen.getByText(/problem on our side/i)).toBeInTheDocument()
    expect(screen.queryByTestId("credential-entry-input")).toBeNull()
  })

  it("reports a spent link and removes the field", async () => {
    storeCredentialMock.mockResolvedValue(ok({ status: "already-used" }))
    renderForm()
    fireEvent.change(field(), { target: { value: SECRET } })
    submit()

    await waitFor(() =>
      expect(screen.getByText(/Link already used/i)).toBeInTheDocument()
    )
    expect(screen.queryByTestId("credential-entry-input")).toBeNull()
  })

  it("says the link is spent when the write failed after the claim", async () => {
    storeCredentialMock.mockResolvedValue(
      ok({ status: "write-failed", credentialName: CREDENTIAL })
    )
    renderForm()
    fireEvent.change(field(), { target: { value: SECRET } })
    submit()

    await waitFor(() =>
      expect(screen.getByText(/Could not save credential/i)).toBeInTheDocument()
    )
    // The user must be told to get a NEW link, not to retry this one.
    expect(screen.getByText(/now spent/i)).toBeInTheDocument()
    expect(screen.queryByTestId("credential-entry-input")).toBeNull()
    expect(document.body.textContent).not.toContain(SECRET)
  })

  it.each([
    ["wrong-user", { status: "wrong-user" as const, expected: OWNER }],
    ["invalid-token", { status: "invalid-token" as const }],
    ["needs-signin", { status: "needs-signin" as const, ownerEmail: OWNER }],
  ])("removes the field when the action refuses with %s", async (_label, outcome) => {
    storeCredentialMock.mockResolvedValue(ok(outcome))
    renderForm()
    fireEvent.change(field(), { target: { value: SECRET } })
    submit()

    await waitFor(() =>
      expect(screen.getByText(/can no longer be used/i)).toBeInTheDocument()
    )
    expect(screen.queryByTestId("credential-entry-input")).toBeNull()
  })

  it("surfaces a thrown action failure without echoing the value", async () => {
    storeCredentialMock.mockResolvedValue({
      isSuccess: false,
      message: "Could not store that credential",
    })
    renderForm()
    fireEvent.change(field(), { target: { value: SECRET } })
    submit()

    await waitFor(() =>
      expect(
        screen.getByText(/Could not store that credential/i)
      ).toBeInTheDocument()
    )
    expect(document.body.textContent).not.toContain(SECRET)
  })
})

describe("credential entry form — duplicate submits", () => {
  it("never sends a second submit while the first is in flight", async () => {
    // Two submits dispatched before isPending commits. Only one can win the
    // server's atomic claim and the UI cannot tell which, so the second must
    // never be sent — otherwise the loser's "already used" reply could repaint
    // a stored credential as a failure. Submitted on the FORM rather than the
    // button because the button is disabled once the first submit commits.
    let resolveFirst: (value: unknown) => void = () => {}
    const first = new Promise((resolve) => {
      resolveFirst = resolve
    })
    storeCredentialMock
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(ok({ status: "already-used" }))
    const { container } = renderForm()
    fireEvent.change(field(), { target: { value: SECRET } })
    const form = container.querySelector("form") as HTMLFormElement
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(storeCredentialMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirst(
        ok({ status: "stored", credentialName: CREDENTIAL, action: "created" })
      )
      await first
    })
    await waitFor(() =>
      expect(screen.getByText(/Credential saved/i)).toBeInTheDocument()
    )
    expect(screen.queryByText(/Link already used/i)).toBeNull()
    expect(storeCredentialMock).toHaveBeenCalledTimes(1)
  })

  it("allows a resubmit after a rejected value", async () => {
    storeCredentialMock
      .mockResolvedValueOnce(ok({ status: "invalid-value", credentialName: CREDENTIAL, reason: "Too short." }))
      .mockResolvedValueOnce(
        ok({ status: "stored", credentialName: CREDENTIAL, action: "created" })
      )
    const { container } = renderForm()
    fireEvent.change(field(), { target: { value: SECRET } })
    const form = container.querySelector("form") as HTMLFormElement
    fireEvent.submit(form)
    await waitFor(() => expect(screen.getByText(/Too short/i)).toBeInTheDocument())

    fireEvent.change(field(), { target: { value: SECRET } })
    fireEvent.submit(form)
    await waitFor(() =>
      expect(screen.getByText(/Credential saved/i)).toBeInTheDocument()
    )
    expect(storeCredentialMock).toHaveBeenCalledTimes(2)
  })
})
