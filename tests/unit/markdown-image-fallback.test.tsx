/**
 * #1900 — a markdown image that cannot load must say so.
 *
 * Nexus images were raw S3 presigned URLs, which expire and fail
 * intermittently with `InvalidToken`. A broken `<img>` renders as nothing at
 * all, so staff saw a reply that had quietly lost its picture. The fallback
 * makes the failure visible and names it.
 */

jest.mock("@assistant-ui/react-markdown/styles/dot.css", () => ({}), {
  virtual: true,
})
jest.mock("katex/dist/katex.min.css", () => ({}), { virtual: true })
// The unified/remark/rehype ecosystem is pure ESM and next/jest does not
// transform it in node_modules; these plugins are inert for this test anyway.
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => undefined }))
jest.mock("remark-math", () => ({ __esModule: true, default: () => undefined }))
jest.mock("rehype-katex", () => ({ __esModule: true, default: () => undefined }))
jest.mock("@assistant-ui/react-markdown", () => ({
  MarkdownTextPrimitive: () => null,
  unstable_memoizeMarkdownComponents: (components: unknown) => components,
  useIsMarkdownCodeBlock: () => false,
}))
jest.mock("@/components/assistant-ui/shiki-highlighter", () => ({
  SyntaxHighlighter: () => null,
}))
jest.mock("@/components/assistant-ui/mermaid-diagram", () => ({
  MermaidDiagram: () => null,
}))
jest.mock("@/components/assistant-ui/collapsible-document", () => ({
  CollapsibleDocument: () => null,
}))

import { fireEvent, render, screen } from "@testing-library/react"
import { MarkdownImage } from "@/components/assistant-ui/markdown-text"

describe("MarkdownImage", () => {
  it("renders the image normally until it fails", () => {
    render(<MarkdownImage src="/api/images/v2/generated-images/a/b.png" alt="A kitten" />)

    expect(screen.getByAltText("A kitten")).toBeInTheDocument()
    expect(screen.queryByText(/Image unavailable/)).not.toBeInTheDocument()
  })

  it("shows a visible 'image unavailable' fallback once loading fails", () => {
    render(<MarkdownImage src="https://s3.example.test/expired" alt="A kitten" />)

    fireEvent.error(screen.getByAltText("A kitten"))

    expect(screen.getByText(/Image unavailable — A kitten/)).toBeInTheDocument()
    expect(screen.queryByAltText("A kitten")).not.toBeInTheDocument()
  })

  it("labels the fallback for assistive technology", () => {
    render(<MarkdownImage src="https://s3.example.test/expired" alt="A kitten" />)

    fireEvent.error(screen.getByAltText("A kitten"))

    expect(
      screen.getByRole("img", { name: "Image unavailable: A kitten" }),
    ).toBeInTheDocument()
  })

  it("still renders a different src after an earlier one failed", () => {
    const { rerender } = render(
      <MarkdownImage src="https://s3.example.test/expired" alt="A kitten" />,
    )
    fireEvent.error(screen.getByAltText("A kitten"))
    expect(screen.getByText(/Image unavailable/)).toBeInTheDocument()

    rerender(<MarkdownImage src="/api/images/v2/generated-images/a/b.png" alt="A kitten" />)

    expect(screen.getByAltText("A kitten")).toBeInTheDocument()
    expect(screen.queryByText(/Image unavailable/)).not.toBeInTheDocument()
  })
})
