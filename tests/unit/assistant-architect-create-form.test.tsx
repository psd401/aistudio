/**
 * Regression coverage for Issue #1697 (FS#164138): "Add Field" and "Continue"
 * looked like dead buttons on the Assistant Architect create page.
 *
 * Mechanism: `imagePath` (the icon grid) is required, but a blocked submit
 * reported itself only through a toast that never rendered and a
 * `form.setFocus("imagePath")` that had no ref to focus. Nothing moved, nothing
 * appeared — so the user could not tell the click had been rejected.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const mockToast = jest.fn()
const mockCreate = jest.fn()
const mockUpdate = jest.fn()
const mockAddInputField = jest.fn()

jest.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: (...args: unknown[]) => mockToast(...args) }),
  toast: (...args: unknown[]) => mockToast(...args),
}))

jest.mock("@/actions/db/assistant-architect-actions", () => ({
  createAssistantArchitectAction: (...args: unknown[]) => mockCreate(...args),
  updateAssistantArchitectAction: (...args: unknown[]) => mockUpdate(...args),
  addToolInputFieldAction: (...args: unknown[]) => mockAddInputField(...args),
  updateInputFieldAction: jest.fn(),
  deleteInputFieldAction: jest.fn(),
}))

// The shared radix primitives mock does not cover AlertDialog.Portal, which
// `input-fields-section` pulls in for its delete confirmation.
jest.mock("@/components/ui/alert-dialog", () => {
  const React = require("react")
  const pass =
    (tag: string) =>
    function MockPassThrough({ children }: { children?: React.ReactNode }) {
      return React.createElement(tag, null, children)
    }
  return {
    AlertDialog: ({ open, children }: { open?: boolean; children?: React.ReactNode }) =>
      open ? React.createElement("div", null, children) : null,
    AlertDialogAction: pass("button"),
    AlertDialogCancel: pass("button"),
    AlertDialogContent: pass("div"),
    AlertDialogDescription: pass("p"),
    AlertDialogFooter: pass("div"),
    AlertDialogHeader: pass("div"),
    AlertDialogTitle: pass("h2"),
  }
})

// The agentic + routing panels are unrelated to this bug and pull a lot of
// surface (model catalogue fetches, flyouts). Keep the test on the create flow.
jest.mock(
  "@/app/(protected)/utilities/assistant-architect/create/_components/agentic-mode-section",
  () => ({ AgenticModeSection: () => null })
)
jest.mock(
  "@/app/(protected)/utilities/assistant-architect/create/_components/model-routing-section",
  () => ({ ModelRoutingSection: () => null })
)

import { CreateForm } from "@/app/(protected)/utilities/assistant-architect/create/_components/create-form"

const IMAGES = ["robot.png", "owl.png"]

beforeEach(() => {
  jest.clearAllMocks()
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ images: IMAGES }),
  }) as unknown as typeof fetch
})

async function renderForm() {
  render(<CreateForm />)
  // Icons arrive from /api/assistant-images after mount.
  await waitFor(() => expect(screen.getByLabelText(`Select ${IMAGES[0]} as assistant icon`)).toBeInTheDocument())
}

describe("Assistant Architect create form — blocked submit is visible", () => {
  it("marks the icon as required so the requirement is discoverable", async () => {
    await renderForm()

    expect(screen.getByText("(required)")).toBeInTheDocument()
    expect(screen.getByText("Pick an icon — required before you can continue.")).toBeInTheDocument()
  })

  it("Continue with no icon selected reports the reason instead of doing nothing", async () => {
    await renderForm()

    fireEvent.change(screen.getByPlaceholderText("Enter assistant name..."), {
      target: { value: "Lesson planner" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Cannot continue", variant: "destructive" })
      )
    )
    expect(mockToast.mock.calls[0][0].description).toMatch(/image/i)
    expect(mockCreate).not.toHaveBeenCalled()

    // The message also renders inline, and focus moves to the offending field —
    // without the forwarded ref, setFocus() had nowhere to land.
    const grid = screen.getByTestId("assistant-icon-grid")
    await waitFor(() => expect(grid).toHaveFocus())
    expect(grid).toHaveAttribute("aria-invalid", "true")
    expect(screen.getByText("Please select an image for your assistant.")).toBeInTheDocument()
  })

  /**
   * The toast and the focus ring must name the SAME field. They did not: the
   * toast reports the first error in schema order (name) while react-hook-form's
   * own `_focusError()` walks fields in registration order (the icon grid renders
   * first) and runs after the invalid callback, so it always won. A user on a
   * blank form was told "Name must be at least 3 characters" while the focus and
   * the highlight landed on the icon grid. The form now sets
   * `shouldFocusError: false` so reportValidationFailure is the only thing that
   * moves focus. Asserting the toast TITLE alone cannot catch this regression.
   */
  it("points the focus at the same field the toast names", async () => {
    await renderForm()

    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    await waitFor(() => expect(mockToast).toHaveBeenCalled())
    const { description } = mockToast.mock.calls[0][0]

    // A wholly blank form fails on `name` first in schema order.
    expect(description).toMatch(/name/i)
    await waitFor(() =>
      expect(screen.getByPlaceholderText("Enter assistant name...")).toHaveFocus()
    )
    // …and NOT on the icon grid, which is what registration order would pick.
    expect(screen.getByTestId("assistant-icon-grid")).not.toHaveFocus()
  })

  it("Add Field with no icon selected is blocked the same way, with feedback", async () => {
    await renderForm()

    fireEvent.click(screen.getByRole("button", { name: /Add Field/ }))

    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Cannot continue", variant: "destructive" })
      )
    )
    expect(mockCreate).not.toHaveBeenCalled()
    expect(screen.getByTestId("assistant-icon-grid")).toHaveAttribute("aria-invalid", "true")
  })

  it("a complete form saves and advances", async () => {
    mockCreate.mockResolvedValue({ isSuccess: true, data: { id: 42 } })
    await renderForm()

    fireEvent.change(screen.getByPlaceholderText("Enter assistant name..."), {
      target: { value: "Lesson planner" },
    })
    fireEvent.click(screen.getByLabelText(`Select ${IMAGES[0]} as assistant icon`))
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Lesson planner", imagePath: IMAGES[0], status: "draft" })
      )
    )
    expect(mockToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ variant: "destructive" })
    )
  })
})
