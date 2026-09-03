/** @jest-environment jsdom */

/**
 * `CreateContentDialog` busy/error lifecycle (#1714).
 *
 * The library create handlers call a server action. When that POST is blocked
 * at the edge (the WAF's `CrossSiteScripting_BODY` rule returns a bare 403 with
 * an HTML body, which is not a valid server-action response), the action call
 * REJECTS — it does not resolve to `isSuccess: false`. The dialog previously
 * awaited `onSubmit` with no `try/catch`, so `creating` stayed true and "Build
 * it for me" spun forever with no message; "Start blank" reported through the
 * library-level error state that renders BEHIND the open dialog, so it looked
 * like a no-op.
 *
 * These tests pin the contract that both paths recover: an error is shown and
 * the buttons are re-enabled, whether the handler REJECTS or RESOLVES to a
 * message.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

// The real dialog renders through a Radix portal, whose primitive mock does not
// provide `DialogPortal`. Shell it out to plain elements: what is under test is
// this component's busy/error state machine, not Radix's overlay behaviour.
jest.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { CreateContentDialog } from "@/components/atrium/CreateContentDialog";

function typePrompt(text: string): void {
  fireEvent.change(
    screen.getByLabelText("Describe the artifact for the agent to build"),
    { target: { value: text } }
  );
}

function buildButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /build it for me/i,
  }) as HTMLButtonElement;
}

function startBlankButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: /start blank/i,
  }) as HTMLButtonElement;
}

describe("CreateContentDialog — create failure recovery (#1714)", () => {
  it("clears the spinner and shows a message when onSubmit REJECTS", async () => {
    const onSubmit = jest.fn(async () => {
      throw new Error("Failed to fetch");
    });

    render(
      <CreateContentDialog open onClose={jest.fn()} onSubmit={onSubmit} />
    );

    typePrompt("a budget explainer");
    fireEvent.click(buildButton());

    await waitFor(() => expect(buildButton()).not.toBeDisabled());
    expect(onSubmit).toHaveBeenCalledWith("a budget explainer");
    expect(
      screen.getByText("Something went wrong. Please try again.")
    ).toBeInTheDocument();
  });

  it("shows the returned message and re-enables when onSubmit RESOLVES to an error", async () => {
    const onSubmit = jest.fn(async () => "Could not create the artifact");

    render(
      <CreateContentDialog open onClose={jest.fn()} onSubmit={onSubmit} />
    );

    typePrompt("a dashboard");
    fireEvent.click(buildButton());

    await waitFor(() =>
      expect(
        screen.getByText("Could not create the artifact")
      ).toBeInTheDocument()
    );
    expect(buildButton()).not.toBeDisabled();
  });

  it("surfaces a Start blank failure IN the dialog and re-enables the buttons", async () => {
    const onStartBlank = jest.fn(async () => {
      throw new Error("Failed to fetch");
    });

    render(
      <CreateContentDialog
        open
        onClose={jest.fn()}
        onSubmit={jest.fn(async () => null)}
        onStartBlank={onStartBlank}
      />
    );

    fireEvent.click(startBlankButton());

    await waitFor(() => expect(startBlankButton()).not.toBeDisabled());
    expect(onStartBlank).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText("Something went wrong. Please try again.")
    ).toBeInTheDocument();
  });

  it("keeps the buttons disabled after a successful create (the caller navigates away)", async () => {
    const onStartBlank = jest.fn(async () => null);

    render(
      <CreateContentDialog
        open
        onClose={jest.fn()}
        onSubmit={jest.fn(async () => null)}
        onStartBlank={onStartBlank}
      />
    );

    fireEvent.click(startBlankButton());

    await waitFor(() => expect(onStartBlank).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(startBlankButton()).toBeDisabled());
    expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
  });

  it("does not call onSubmit for an empty prompt", async () => {
    const onSubmit = jest.fn(async () => null);

    render(
      <CreateContentDialog open onClose={jest.fn()} onSubmit={onSubmit} />
    );

    fireEvent.click(buildButton());

    await waitFor(() =>
      expect(
        screen.getByText("Describe what you'd like the agent to build.")
      ).toBeInTheDocument()
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
