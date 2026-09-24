/** @jest-environment jsdom */

/**
 * #1791 finding 2 regression: an armed draft must actually SEND.
 *
 * The loader strips `draft`/`send` from the URL. In the app that rewrite
 * changes `searchParams`, which re-runs the loader's effect — and the effect's
 * cleanup used to cancel the send scheduled 100 ms later, so an Ask-card
 * question was consumed and merely prefilled. This harness makes
 * `router.replace` re-render with the rewritten params on the next tick (a fast
 * client-side navigation), which is exactly the ordering that lost the send.
 */

import { act, render } from "@testing-library/react";

let currentParams = new URLSearchParams();
let rerenderLoader: () => void = () => {};
const replace = jest.fn((href: string) => {
  currentParams = new URL(href, "https://example.test").searchParams;
  // The navigation lands on a later tick but well inside the 100 ms send
  // delay, as a client-side query-string update does in the app.
  setTimeout(() => rerenderLoader(), 0);
});
const router = { replace, push: jest.fn() };

jest.mock("next/navigation", () => ({
  useSearchParams: () => currentParams,
  useRouter: () => router,
}));

const composer = {
  getState: jest.fn(() => ({ text: "" })),
  setText: jest.fn(),
  send: jest.fn(),
};
jest.mock("@assistant-ui/react", () => ({
  useComposerRuntime: () => composer,
}));
jest.mock("@/lib/hooks/use-action", () => ({
  useAction: () => ({ execute: jest.fn() }),
}));
jest.mock("@/actions/prompt-library.actions", () => ({
  getPrompt: jest.fn(),
  trackPromptUse: jest.fn(),
}));
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }));
jest.mock("@/lib/client-logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

import { PromptAutoLoader } from "@/app/(protected)/nexus/_components/prompt-auto-loader";
import { nexusWorkspaceHref } from "@/lib/nexus/draft-auto-send";

function mountAt(href: string) {
  currentParams = new URL(href, "https://example.test").searchParams;
  const view = render(<PromptAutoLoader />);
  rerenderLoader = () => view.rerender(<PromptAutoLoader />);
  return view;
}

function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  window.sessionStorage.clear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("PromptAutoLoader draft auto-send", () => {
  it("sends an armed draft even though stripping the URL re-runs the effect", () => {
    mountAt(
      nexusWorkspaceHref({ workspaceId: "obj-1", draft: "Add a chart", autoSend: true })
    );
    expect(composer.setText).toHaveBeenCalledWith("Add a chart");

    // Two act() scopes: React flushes the re-render's effects (and their
    // cleanup) when the FIRST scope exits, before the 100 ms send timer runs.
    advance(10);
    advance(140);

    expect(composer.send).toHaveBeenCalledTimes(1);
    // ...and the draft/nonce are stripped afterwards, keeping workspace.
    const last = replace.mock.calls.at(-1)?.[0] as string;
    const params = new URL(last, "https://example.test").searchParams;
    expect(params.get("workspace")).toBe("obj-1");
    expect(params.has("draft")).toBe(false);
    expect(params.has("send")).toBe(false);
  });

  it("only prefills an unarmed draft (an external link)", () => {
    mountAt("/nexus?workspace=obj-1&draft=Add+a+chart&send=forged-nonce");

    advance(10);
    advance(140);

    expect(composer.setText).toHaveBeenCalledWith("Add a chart");
    expect(composer.send).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("does not send after the loader unmounts", () => {
    const view = mountAt(
      nexusWorkspaceHref({ workspaceId: "obj-1", draft: "Add a chart", autoSend: true })
    );
    rerenderLoader = () => {};
    view.unmount();

    advance(150);

    expect(composer.send).not.toHaveBeenCalled();
  });
});
