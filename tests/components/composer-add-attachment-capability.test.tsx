/**
 * Regression tests for #1735 (FS#165437) — "attachment button does not work".
 *
 * The shared composer (`components/assistant-ui/thread.tsx`) is used by both Nexus
 * and Assistant Architect, but only Nexus wired an attachment adapter into its
 * runtime. assistant-ui's own `disabled` flag on `ComposerPrimitive.AddAttachment`
 * only tracks composer editing state, so the paperclip stayed live on the
 * adapter-less runtime and `composer.addAttachment()` rejected with
 * "Attachments are not supported" — an unhandled promise rejection and a dead end
 * for the user.
 *
 * `ComposerAddAttachment` now renders only when the thread runtime reports the
 * `attachments` capability, which assistant-ui derives from
 * `adapters.attachments !== undefined`.
 */

import { render } from "@testing-library/react";
import { screen } from "@testing-library/dom";

// The shared lucide mock does not carry the icons attachment.tsx uses; stub them.
jest.mock("lucide-react", () => {
  const React = require("react");
  const icon = (name: string) =>
    function MockIcon() {
      return React.createElement("span", { "data-testid": `icon-${name}` });
    };
  return {
    CheckCircle2: icon("check-circle-2"),
    CircleXIcon: icon("circle-x"),
    FileIcon: icon("file"),
    Loader2: icon("loader2"),
    PaperclipIcon: icon("paperclip"),
  };
});

const useAuiStateMock = jest.fn();

jest.mock("@assistant-ui/react", () => {
  const React = require("react");
  const passthrough = (testId: string) =>
    function Passthrough({ children }: { children?: React.ReactNode }) {
      return React.createElement("div", { "data-testid": testId }, children);
    };
  return {
    useAuiState: (selector: (state: unknown) => unknown) =>
      useAuiStateMock(selector),
    useAttachment: () => ({}),
    ComposerPrimitive: {
      AddAttachment: function AddAttachment({
        children,
      }: {
        children?: React.ReactNode;
        asChild?: boolean;
      }) {
        return React.createElement(
          "div",
          { "data-testid": "add-attachment" },
          children,
        );
      },
      Attachments: passthrough("composer-attachments"),
    },
    AttachmentPrimitive: {
      Root: passthrough("attachment-root"),
      Name: passthrough("attachment-name"),
      Remove: passthrough("attachment-remove"),
    },
    MessagePrimitive: {
      Attachments: passthrough("message-attachments"),
    },
  };
});

// `repository-attachment-message` pulls in markdown-text -> @assistant-ui/react-markdown,
// which ships pure ESM that next/jest does not transform in node_modules. Stub the only
// export attachment.tsx consumes from it.
jest.mock("@/components/assistant-ui/repository-attachment-message", () => ({
  RepositoryPromotionButton: function RepositoryPromotionButton() {
    return null;
  },
}));

// The tooltip button renders through the shared radix mock, which does not provide a
// usable Tooltip provider chain in jsdom. The gate under test is about whether the
// button renders at all, not how it is styled.
jest.mock("@/components/assistant-ui/tooltip-icon-button", () => {
  const React = require("react");
  return {
    TooltipIconButton: function TooltipIconButton({
      children,
      tooltip,
    }: {
      children?: React.ReactNode;
      tooltip?: string;
    }) {
      return React.createElement(
        "button",
        { type: "button", "aria-label": tooltip },
        children,
      );
    },
  };
});

import { ComposerAddAttachment } from "@/components/assistant-ui/attachment";

/**
 * Mirrors the shape assistant-ui exposes to `useAuiState` selectors so the test
 * exercises the real selector rather than a hardcoded boolean.
 */
function stateWithAttachments(attachments: boolean) {
  return { thread: { capabilities: { attachments } } };
}

describe("ComposerAddAttachment capability gate (#1735)", () => {
  afterEach(() => {
    useAuiStateMock.mockReset();
  });

  it("renders nothing when the runtime has no attachment adapter", () => {
    useAuiStateMock.mockImplementation((selector: (s: unknown) => unknown) =>
      selector(stateWithAttachments(false)),
    );

    const { container } = render(<ComposerAddAttachment />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("add-attachment")).toBeNull();
  });

  it("renders the paperclip when the runtime supports attachments", () => {
    useAuiStateMock.mockImplementation((selector: (s: unknown) => unknown) =>
      selector(stateWithAttachments(true)),
    );

    render(<ComposerAddAttachment />);

    expect(screen.getByTestId("add-attachment")).toBeTruthy();
  });

  it("reads the capability from the thread scope", () => {
    useAuiStateMock.mockImplementation((selector: (s: unknown) => unknown) =>
      selector(stateWithAttachments(true)),
    );

    render(<ComposerAddAttachment />);

    const selector = useAuiStateMock.mock.calls[0][0] as (
      s: unknown,
    ) => unknown;
    expect(selector(stateWithAttachments(false))).toBe(false);
    expect(selector(stateWithAttachments(true))).toBe(true);
  });
});
