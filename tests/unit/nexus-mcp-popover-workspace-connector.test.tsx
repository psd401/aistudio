/**
 * The composer's Connect popover must not lie about the turn's tools (#1786).
 *
 * The router attaches the PSD Data connector to every turn sent while an
 * editable workspace artifact is open. Before this, the popover showed that
 * connector's toggle OFF on exactly those turns, so a user had no way to tell
 * whether the model could see the data — and switching it on by hand was the
 * only reliable workaround. These tests pin the two halves of the fix: the open
 * workspace reaches the server, and an auto-attached connector renders as on,
 * locked, and explained.
 */

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MCPPopover } from "@/app/(protected)/nexus/_components/chat/mcp-popover";
import type { ConnectorWithStatus } from "@/actions/mcp-connector.actions";

const getConnectorsMock = jest.fn();
jest.mock("@/actions/mcp-connector.actions", () => ({
  getConnectorsWithStatus: (...a: unknown[]) => getConnectorsMock(...a),
}));
jest.mock("@/app/(protected)/nexus/_components/chat/oauth-popup", () => ({
  openOAuthPopup: jest.fn(),
}));
// Radix's popover is ESM-only under this jest transform, and the portal would
// hide the rows from the query anyway. Render the parts inline and drive `open`
// off the trigger click, which is what the real popover does.
jest.mock("@/components/ui/popover", () => {
  const React = require("react") as typeof import("react");
  const OpenContext = React.createContext(false);
  return {
    Popover: ({
      open,
      onOpenChange,
      children,
    }: {
      open: boolean;
      onOpenChange: (next: boolean) => void;
      children: React.ReactNode;
    }) =>
      React.createElement(
        OpenContext.Provider,
        { value: open },
        // A click anywhere inside opens it, which is enough to reach the trigger
        // the real popover wires through `asChild`.
        React.createElement("div", { onClick: () => onOpenChange(true) }, children)
      ),
    PopoverTrigger: ({ children }: { children: React.ReactNode }) => children,
    PopoverContent: ({ children }: { children: React.ReactNode }) =>
      React.useContext(OpenContext)
        ? React.createElement("div", null, children)
        : null,
  };
});
// lucide-react ships ESM icons jest cannot load.
jest.mock("lucide-react", () => ({
  Plug: () => <span data-testid="icon-plug" />,
  Loader2: () => <span data-testid="icon-loader" />,
}));

const PSD_DATA_ID = "54f0f531-f7ab-485e-bd6b-65a95c4bc871";
const OTHER_ID = "0a1d5f2c-6b3e-4d90-9c11-2f7a6e8b4c55";

function connector(
  overrides: Partial<ConnectorWithStatus> & Pick<ConnectorWithStatus, "id" | "name">
): ConnectorWithStatus {
  return {
    authType: "none",
    status: "connected",
    autoAttachedForWorkspace: false,
    ...overrides,
  };
}

async function openPopover(props: Partial<React.ComponentProps<typeof MCPPopover>> = {}) {
  const onConnectorsChange = jest.fn();
  render(
    <MCPPopover
      enabledConnectors={[]}
      onConnectorsChange={onConnectorsChange}
      {...props}
    />
  );
  fireEvent.click(screen.getByTestId("nexus-mcp-control"));
  await waitFor(() => expect(getConnectorsMock).toHaveBeenCalled());
  return { onConnectorsChange };
}

describe("Connect popover — workspace-attached connector", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getConnectorsMock.mockResolvedValue({
      isSuccess: true,
      data: [
        connector({ id: PSD_DATA_ID, name: "PSD Data", autoAttachedForWorkspace: true }),
        connector({ id: OTHER_ID, name: "Notes", status: "no_token" }),
      ],
    });
  });

  it("tells the server which workspace is open so the answer matches the turn", async () => {
    await openPopover({ workspaceId: "device-repairs" });

    expect(getConnectorsMock).toHaveBeenCalledWith({ workspaceId: "device-repairs" });
  });

  it("shows an auto-attached connector as on and says why", async () => {
    await openPopover({ workspaceId: "device-repairs" });

    const row = await screen.findByTestId(`nexus-connector-${PSD_DATA_ID}`);
    expect(row).toHaveAttribute("aria-checked", "true");
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).toHaveTextContent("On for this workspace");
  });

  it("does not let the user switch off a connector the router will attach anyway", async () => {
    const { onConnectorsChange } = await openPopover({ workspaceId: "device-repairs" });

    fireEvent.click(await screen.findByTestId(`nexus-connector-${PSD_DATA_ID}`));

    expect(onConnectorsChange).not.toHaveBeenCalled();
  });

  it("leaves every other connector's toggle alone", async () => {
    const { onConnectorsChange } = await openPopover({ workspaceId: "device-repairs" });

    const row = await screen.findByTestId(`nexus-connector-${OTHER_ID}`);
    expect(row).toHaveAttribute("aria-checked", "false");
    expect(row).not.toHaveAttribute("aria-disabled");
    expect(row).toHaveTextContent("Not connected");

    fireEvent.click(row);
    expect(onConnectorsChange).toHaveBeenCalledWith([OTHER_ID]);
  });

  it("counts the auto-attached connector in the trigger badge", async () => {
    await openPopover({ workspaceId: "device-repairs" });

    await screen.findByTestId(`nexus-connector-${PSD_DATA_ID}`);
    expect(screen.getByTestId("nexus-mcp-control")).toHaveTextContent("1");
  });

  it("behaves exactly as before when nothing is auto-attached", async () => {
    getConnectorsMock.mockResolvedValue({
      isSuccess: true,
      data: [connector({ id: PSD_DATA_ID, name: "PSD Data" })],
    });

    const { onConnectorsChange } = await openPopover();

    expect(getConnectorsMock).toHaveBeenCalledWith({ workspaceId: undefined });
    const row = await screen.findByTestId(`nexus-connector-${PSD_DATA_ID}`);
    expect(row).toHaveAttribute("aria-checked", "false");
    expect(row).toHaveTextContent("Connected");

    fireEvent.click(row);
    expect(onConnectorsChange).toHaveBeenCalledWith([PSD_DATA_ID]);
  });
});
