/**
 * Regression guard for Issue #1697.
 *
 * `@/components/ui/use-toast` used to push onto a module-level queue rendered
 * only by `components/ui/toaster.tsx`, which was never mounted — so every
 * `toast()` call in the app (~60 files) was silently mute, and the Assistant
 * Architect create flow reported blocked validation into the void. These tests
 * pin the two halves of the invariant: the hook writes to sonner, and the root
 * layout mounts sonner.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

// Mocks are created inside the factory: `jest.mock` is hoisted above every
// `const` in this file, so referencing outer bindings from the factory throws.
jest.mock("sonner", () => ({
  toast: Object.assign(jest.fn(() => 1), {
    error: jest.fn(() => 2),
    dismiss: jest.fn(),
  }),
}))

import { toast, useToast } from "@/components/ui/use-toast"
import { toast as mockedSonner } from "sonner"

const sonnerToast = mockedSonner as unknown as jest.Mock
const sonnerError = mockedSonner.error as unknown as jest.Mock
const sonnerDismiss = mockedSonner.dismiss as unknown as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
})

describe("use-toast → sonner adapter", () => {
  it("routes a destructive toast to sonner's error channel", () => {
    toast({
      title: "Cannot continue",
      description: "Please select an image for your assistant.",
      variant: "destructive",
    })

    expect(sonnerError).toHaveBeenCalledTimes(1)
    expect(sonnerError).toHaveBeenCalledWith(
      "Cannot continue",
      expect.objectContaining({ description: "Please select an image for your assistant." })
    )
    expect(sonnerToast).not.toHaveBeenCalled()
  })

  it("routes a default toast to sonner's neutral channel", () => {
    toast({ title: "Success", description: "Assistant created" })

    expect(sonnerToast).toHaveBeenCalledWith(
      "Success",
      expect.objectContaining({ description: "Assistant created" })
    )
    expect(sonnerError).not.toHaveBeenCalled()
  })

  it("does not drop a description-only toast", () => {
    toast({ description: "Saved" })

    expect(sonnerToast).toHaveBeenCalledWith("Saved", expect.objectContaining({ description: undefined }))
  })

  it("passes duration through", () => {
    toast({ title: "Heads up", duration: 8000 })

    expect(sonnerToast).toHaveBeenCalledWith("Heads up", expect.objectContaining({ duration: 8000 }))
  })

  it("exposes the hook form, and it reaches sonner too", () => {
    const { toast: hookToast, dismiss } = useToast()
    hookToast({ title: "From the hook", variant: "destructive" })

    expect(sonnerError).toHaveBeenCalledWith("From the hook", expect.any(Object))

    dismiss("abc")
    expect(sonnerDismiss).toHaveBeenCalledWith("abc")
  })

  it("updates and dismisses by the id sonner returned", () => {
    const handle = toast({ title: "Uploading" })
    expect(handle.id).toBe(1)

    handle.update({ title: "Uploaded" })
    expect(sonnerToast).toHaveBeenLastCalledWith("Uploaded", expect.objectContaining({ id: 1 }))

    handle.dismiss()
    expect(sonnerDismiss).toHaveBeenCalledWith(1)
  })
})

describe("toast root wiring", () => {
  it("mounts the same toast system the hook writes to", () => {
    const layout = readFileSync(join(process.cwd(), "app/layout.tsx"), "utf8")

    expect(layout).toMatch(/import\s*\{\s*Toaster\s*\}\s*from\s*['"]sonner['"]/)
    expect(layout).toMatch(/<Toaster\b/)
  })
})
