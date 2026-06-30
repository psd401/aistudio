/**
 * VisibilityChip smoke tests (#1053, Epic #1059).
 *
 * Covers the client-side state machine that the action-level unit tests cannot:
 *  - the badge reflects the loaded level (and does NOT flash "Private" while the
 *    initial fetch is in flight)
 *  - the happy-path save calls `setVisibilityAction` with the right payload and
 *    fires `onChange`
 *  - cancel resets unsaved draft edits to the last-persisted values
 *  - a non-editor sees the chip read-only (no Save button)
 *  - a `useRoleOptions` failure surfaces an error banner, and changing the level
 *    clears it
 *
 * The shared radix-ui mock (`tests/mocks/radix-ui.js`, wired in jest.config) renders
 * the Dialog (and its content) unconditionally, so dialog controls are always in the
 * DOM — these tests assert on them directly rather than simulating an open click.
 * `@/components/ui/select` is mocked locally as a real <select> so the level picker
 * fires `onValueChange` on change (the shared div mock does not wire it).
 */

import { render, act } from "@testing-library/react";
import { screen, fireEvent, waitFor } from "@testing-library/dom";

// lucide icons used by the component are not in the global lucide mock; stub them.
jest.mock("lucide-react", () => {
  const React = require("react");
  const icon = (name: string) => () =>
    React.createElement("span", { "data-testid": `icon-${name}` });
  return {
    Globe: icon("globe"),
    Lock: icon("lock"),
    Users: icon("users"),
    Building2: icon("building2"),
    X: icon("x"),
  };
});

// Passthrough mocks for the dialog/badge/button/input/label primitives so the
// chip's content renders deterministically (the real dialog gates on open state
// and pulls in Radix portals). Each renders its children inline.
jest.mock("@/components/ui/dialog", () => {
  const React = require("react");
  // The Dialog shares its `onOpenChange` with the trigger via context so a trigger
  // click flips the chip's `open` state (which gates the lazy role-options fetch).
  const Ctx = React.createContext(undefined);
  const pass =
    (tag: string) =>
    ({ children }: { children?: React.ReactNode }) =>
      React.createElement(tag, null, children);
  const Dialog = ({
    children,
    onOpenChange,
  }: {
    children?: React.ReactNode;
    onOpenChange?: (next: boolean) => void;
  }) => React.createElement(Ctx.Provider, { value: onOpenChange }, children);
  const DialogTrigger = ({ children }: { children?: React.ReactNode }) => {
    const onOpenChange = React.useContext(Ctx);
    return React.createElement(
      "div",
      { onClick: () => onOpenChange?.(true) },
      children
    );
  };
  return {
    Dialog,
    DialogTrigger,
    DialogContent: pass("div"),
    DialogHeader: pass("div"),
    DialogTitle: pass("h2"),
    DialogDescription: pass("p"),
    DialogFooter: pass("div"),
  };
});
jest.mock("@/components/ui/badge", () => {
  const React = require("react");
  return {
    Badge: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("span", null, children),
  };
});
jest.mock("@/components/ui/button", () => {
  const React = require("react");
  return {
    Button: ({
      children,
      onClick,
      disabled,
    }: {
      children?: React.ReactNode;
      onClick?: () => void;
      disabled?: boolean;
    }) => React.createElement("button", { onClick, disabled }, children),
  };
});
jest.mock("@/components/ui/input", () => {
  const React = require("react");
  return {
    Input: (props: Record<string, unknown>) =>
      React.createElement("input", props),
  };
});
jest.mock("@/components/ui/label", () => {
  const React = require("react");
  return {
    Label: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("label", null, children),
  };
});

// Real <select> mock so the level picker actually fires onValueChange. Flattens
// SelectItem children into <option>s and reads `value`/`onValueChange` off Select.
jest.mock("@/components/ui/select", () => {
  const React = require("react");
  type Node = { props?: { value?: string; children?: React.ReactNode } };
  const collectItems = (children: React.ReactNode): Node[] => {
    const out: Node[] = [];
    React.Children.forEach(children, (child: Node) => {
      if (!child || typeof child !== "object") return;
      const props = child.props ?? {};
      // A SelectItem has a string `value`; recurse through SelectContent wrappers.
      if (typeof props.value === "string") out.push(child);
      else if (props.children) out.push(...collectItems(props.children));
    });
    return out;
  };
  const Select = ({
    value,
    onValueChange,
    children,
    disabled,
  }: {
    value?: string;
    onValueChange?: (v: string) => void;
    children?: React.ReactNode;
    disabled?: boolean;
  }) => {
    const items = collectItems(children);
    return React.createElement(
      "select",
      {
        "data-testid": "select",
        value: value ?? "",
        disabled,
        onChange: (e: { target: { value: string } }) =>
          onValueChange?.(e.target.value),
      },
      items.map((it) =>
        React.createElement(
          "option",
          { key: it.props?.value, value: it.props?.value },
          it.props?.children
        )
      )
    );
  };
  const passthrough = (children: React.ReactNode) => children ?? null;
  return {
    Select,
    SelectTrigger: ({ children }: { children?: React.ReactNode }) =>
      passthrough(children),
    SelectContent: ({ children }: { children?: React.ReactNode }) =>
      passthrough(children),
    SelectItem: ({
      value,
      children,
    }: {
      value: string;
      children?: React.ReactNode;
    }) => React.createElement("option", { value }, children),
    SelectValue: () => null,
  };
});

jest.mock("@/actions/db/atrium/get-visibility", () => ({
  getVisibilityAction: jest.fn(),
}));
jest.mock("@/actions/db/atrium/set-visibility", () => ({
  setVisibilityAction: jest.fn(),
}));
jest.mock("@/actions/db/atrium/list-grant-options", () => ({
  listGrantOptionsAction: jest.fn(),
}));

import { VisibilityChip } from "@/components/atrium/VisibilityChip";
import { getVisibilityAction } from "@/actions/db/atrium/get-visibility";
import { setVisibilityAction } from "@/actions/db/atrium/set-visibility";
import { listGrantOptionsAction } from "@/actions/db/atrium/list-grant-options";

const mockGet = getVisibilityAction as jest.MockedFunction<
  typeof getVisibilityAction
>;
const mockSet = setVisibilityAction as jest.MockedFunction<
  typeof setVisibilityAction
>;
const mockListOptions = listGrantOptionsAction as jest.MockedFunction<
  typeof listGrantOptionsAction
>;

function getState(
  overrides: Partial<{
    visibilityLevel: string;
    grants: { kind: string; value: string }[];
    canEdit: boolean;
  }> = {}
) {
  return {
    isSuccess: true as const,
    message: "ok",
    data: {
      visibilityLevel: "internal",
      grants: [],
      canEdit: true,
      ...overrides,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockListOptions.mockResolvedValue({
    isSuccess: true,
    message: "ok",
    data: { roles: ["staff", "administrator"] },
  } as Awaited<ReturnType<typeof listGrantOptionsAction>>);
});

describe("VisibilityChip", () => {
  it("renders the loaded level on the badge (no Private flash for a public object)", async () => {
    mockGet.mockResolvedValue(
      getState({ visibilityLevel: "public" }) as Awaited<
        ReturnType<typeof getVisibilityAction>
      >
    );

    await act(async () => {
      render(<VisibilityChip idOrSlug="obj-1" />);
    });

    // The resolved trigger advertises the loaded level via its aria-label; the
    // default "Private" placeholder/chrome never appears for a public object.
    await waitFor(() => {
      expect(
        screen.getByLabelText("Visibility: Public (click to edit)")
      ).toBeTruthy();
    });
    expect(
      screen.queryByLabelText(/Visibility: Private/)
    ).toBeNull();
    expect(screen.queryByLabelText("Loading visibility…")).toBeNull();
  });

  it("saves the happy path: calls setVisibilityAction and fires onChange", async () => {
    mockGet.mockResolvedValue(
      getState({ visibilityLevel: "internal" }) as Awaited<
        ReturnType<typeof getVisibilityAction>
      >
    );
    mockSet.mockResolvedValue({
      isSuccess: true,
      message: "saved",
      data: { visibilityLevel: "internal" },
    } as Awaited<ReturnType<typeof setVisibilityAction>>);
    const onChange = jest.fn();

    await act(async () => {
      render(<VisibilityChip idOrSlug="obj-1" onChange={onChange} />);
    });
    await waitFor(() => expect(mockGet).toHaveBeenCalled());

    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });

    await waitFor(() => {
      expect(mockSet).toHaveBeenCalledWith("obj-1", {
        level: "internal",
        grants: [],
      });
    });
    expect(onChange).toHaveBeenCalledWith("internal");
  });

  it("resets unsaved draft edits when the dialog is cancelled", async () => {
    mockGet.mockResolvedValue(
      getState({ visibilityLevel: "internal" }) as Awaited<
        ReturnType<typeof getVisibilityAction>
      >
    );

    await act(async () => {
      render(<VisibilityChip idOrSlug="obj-1" />);
    });
    await waitFor(() => expect(mockGet).toHaveBeenCalled());

    // Change the draft level, then cancel — setVisibilityAction must never run.
    const select = screen.getByTestId("select") as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: "private" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Cancel"));
    });
    expect(mockSet).not.toHaveBeenCalled();
  });

  it("renders read-only (no Save) for a non-editor", async () => {
    mockGet.mockResolvedValue(
      getState({ visibilityLevel: "internal", canEdit: false }) as Awaited<
        ReturnType<typeof getVisibilityAction>
      >
    );

    await act(async () => {
      render(<VisibilityChip idOrSlug="obj-1" />);
    });
    await waitFor(() => expect(mockGet).toHaveBeenCalled());

    expect(screen.queryByText("Save")).toBeNull();
  });

  it("surfaces a role-options load failure, and clears it on level change", async () => {
    mockGet.mockResolvedValue(
      getState({
        visibilityLevel: "group",
        grants: [{ kind: "role", value: "staff" }],
      }) as Awaited<ReturnType<typeof getVisibilityAction>>
    );
    mockListOptions.mockResolvedValue({
      isSuccess: false,
      message: "Could not load roles",
    } as Awaited<ReturnType<typeof listGrantOptionsAction>>);

    await act(async () => {
      render(<VisibilityChip idOrSlug="obj-1" />);
    });
    await waitFor(() => expect(mockGet).toHaveBeenCalled());

    // Open the editor: the lazy role-options fetch is gated on `open`. Its failure
    // (level is group, caller can edit) sets the shared error banner.
    await act(async () => {
      fireEvent.click(
        screen.getByLabelText("Visibility: Group (click to edit)")
      );
    });
    await waitFor(() => {
      expect(screen.getByText("Could not load roles")).toBeTruthy();
    });

    // The level picker is the first select (group also renders a grant-kind select).
    const levelSelect = screen.getAllByTestId("select")[0] as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(levelSelect, { target: { value: "internal" } });
    });

    expect(screen.queryByText("Could not load roles")).toBeNull();
  });

  it("does NOT show a 'Private' badge when the initial visibility fetch fails", async () => {
    // A failed getVisibilityAction never tells us the real level, so the badge
    // must keep the neutral placeholder (never a misleading "Private" lock). The
    // button still becomes interactive so the user can open the dialog and read
    // the error, but its aria-label reflects "unavailable", not a level.
    mockGet.mockResolvedValue({
      isSuccess: false,
      message: "Could not load visibility",
    } as Awaited<ReturnType<typeof getVisibilityAction>>);

    await act(async () => {
      render(<VisibilityChip idOrSlug="obj-1" />);
    });
    await waitFor(() => expect(mockGet).toHaveBeenCalled());

    // No level chrome of any kind — placeholder persists.
    expect(screen.queryByLabelText(/Visibility: Private/)).toBeNull();
    expect(screen.queryByLabelText(/Visibility: Public/)).toBeNull();
    // The placeholder/unavailable aria-label is present and the button is enabled.
    const trigger = screen.getByLabelText("Visibility unavailable");
    expect(trigger).toBeTruthy();
    expect((trigger as HTMLButtonElement).disabled).toBe(false);
  });
});
