import { render, screen } from "@testing-library/react";
import {
  RepositoryPromotionAccessProvider,
  RepositoryPromotionButton,
} from "@/components/assistant-ui/repository-attachment-message";

jest.mock("@/components/assistant-ui/markdown-text", () => ({
  MarkdownText: () => <div />,
}));
jest.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
jest.mock("@/lib/client-logger", () => ({
  createLogger: () => ({ warn: jest.fn() }),
}));
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));
jest.mock("lucide-react", () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />;
  return {
    BookMarkedIcon: Icon,
    CheckCircle2: Icon,
    FileIcon: Icon,
    Loader2: Icon,
  };
});

const reference = {
  bindingId: "123e4567-e89b-42d3-a456-426614174000",
  itemId: 44,
  name: "handbook.pdf",
};

describe("repository attachment promotion capability", () => {
  it("hides promotion unless the server-derived capability is present", () => {
    const { rerender } = render(
      <RepositoryPromotionButton
        reference={reference}
        attachmentName={reference.name}
      />
    );
    expect(
      screen.queryByRole("button", { name: "Keep as a repository" })
    ).not.toBeInTheDocument();

    rerender(
      <RepositoryPromotionAccessProvider canPromote>
        <RepositoryPromotionButton
          reference={reference}
          attachmentName={reference.name}
        />
      </RepositoryPromotionAccessProvider>
    );
    expect(
      screen.getByRole("button", { name: "Keep as a repository" })
    ).toBeVisible();
  });
});
