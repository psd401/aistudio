/**
 * Regression: TagInput must let a multi-word tag be typed.
 *
 * The wrapper div is a `role="button"` focus affordance whose `onKeyDown`
 * preventDefault()s Enter and Space. Keydown BUBBLES, so before the
 * `e.target !== e.currentTarget` guard that handler also fired for events
 * originating in the inner text input — cancelling every space the user typed
 * and making a tag like "professional development" impossible to enter.
 *
 * This surfaced when Atrium's ContentSettings replaced its comma-separated
 * free-text field with this shared component (#1336): the old field accepted
 * spaces, so the swap silently regressed existing tag creation.
 */

import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TagInput } from "@/components/ui/tag-input";

describe("TagInput space handling", () => {
  it("accepts spaces typed into the input, so multi-word tags are possible", async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<TagInput value={[]} onChange={onChange} placeholder="Add a tag" />);

    const input = screen.getByPlaceholderText("Add a tag");
    await user.click(input);
    await user.keyboard("professional development");

    expect(input).toHaveValue("professional development");

    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith(["professional development"]);
  });

  it("still focuses the input when the WRAPPER itself takes Space", () => {
    const onChange = jest.fn();
    render(<TagInput value={[]} onChange={onChange} placeholder="Add a tag" />);

    const wrapper = screen.getByRole("button");
    const input = screen.getByPlaceholderText("Add a tag");

    // The guard narrows the handler to the wrapper's own events; it must not
    // disable the a11y affordance that made the handler worth having.
    fireEvent.keyDown(wrapper, { key: " " });
    expect(input).toHaveFocus();
  });
});
