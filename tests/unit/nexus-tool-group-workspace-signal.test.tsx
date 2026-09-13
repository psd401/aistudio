/**
 * A COLLAPSED tool card still signals a workspace change (#1749, PR #1760).
 *
 * The regression this locks in: the signal used to be emitted from the tool-call
 * renderer (`ConnectorToolFallback`), which `GenericToolCard`/`ConnectorToolCard`
 * mount only while `isExpanded` — and the card starts collapsed. assistant-ui
 * wraps EVERY tool call in a group ("Always groups tool calls and reasoning
 * parts, even if there's only one"), so in the default flow the renderer never
 * saw the call run, expanding afterwards hit the history-replay guard, and the
 * workspace panel never refreshed. The observer now lives in `ToolGroup` itself,
 * which renders its header whether or not the card is expanded.
 */

import { render, screen } from "@testing-library/react";
import { ToolGroup } from "@/app/(protected)/nexus/_components/tools/tool-group";
import { WORKSPACE_CHANGED_EVENT } from "@/lib/atrium/workspace-change-event";

const useMessageMock = jest.fn();

jest.mock("@assistant-ui/react", () => ({
  useMessage: () => useMessageMock(),
}));
jest.mock("@/app/(protected)/nexus/_components/tools/connector-tool-context", () => ({
  useConnectorToolsOptional: () => undefined,
}));
jest.mock("lucide-react", () => ({
  ChevronDown: () => <span />,
  ChevronUp: () => <span />,
  Wrench: () => <span />,
  Loader2: () => <span />,
  Plug: () => <span />,
}));

const toolPart = (result: unknown) => ({
  type: "tool-call",
  toolName: "update_workspace_artifact",
  toolCallId: "call-1",
  result,
});

let fired: Array<{ objectId?: string }>;
let listener: (event: Event) => void;

beforeEach(() => {
  jest.clearAllMocks();
  fired = [];
  listener = (event: Event) => {
    fired.push((event as CustomEvent<{ objectId?: string }>).detail);
  };
  window.addEventListener(WORKSPACE_CHANGED_EVENT, listener);
});

afterEach(() => {
  window.removeEventListener(WORKSPACE_CHANGED_EVENT, listener);
});

describe("ToolGroup emits the workspace change signal while collapsed", () => {
  it("fires when the call resolves without the card ever being expanded", () => {
    useMessageMock.mockReturnValue({ content: [toolPart(undefined)] });
    const { rerender } = render(
      <ToolGroup startIndex={0} endIndex={0}>
        <div data-testid="tool-child" />
      </ToolGroup>
    );

    // The card is collapsed, so the renderer (children) is NOT mounted — this is
    // exactly the state the old implementation could not observe.
    expect(screen.queryByTestId("tool-child")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show tool actions/i })).toBeInTheDocument();
    expect(fired).toEqual([]);

    useMessageMock.mockReturnValue({
      content: [toolPart({ ok: true, objectId: "obj-1", versionNumber: 4 })],
    });
    rerender(
      <ToolGroup startIndex={0} endIndex={0}>
        <div data-testid="tool-child" />
      </ToolGroup>
    );

    expect(screen.queryByTestId("tool-child")).not.toBeInTheDocument();
    expect(fired).toEqual([{ objectId: "obj-1" }]);
  });

  it("does not fire for a group whose call arrived already resolved", () => {
    useMessageMock.mockReturnValue({
      content: [toolPart({ ok: true, objectId: "obj-1" })],
    });
    render(
      <ToolGroup startIndex={0} endIndex={0}>
        <div data-testid="tool-child" />
      </ToolGroup>
    );
    expect(fired).toEqual([]);
  });
});
