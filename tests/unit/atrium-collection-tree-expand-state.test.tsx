/**
 * Unit tests for the Atrium CollectionTree's collapsed-by-default, per-viewer
 * persisted expansion state (`useExpandedSections`).
 *
 * The regression these pin: the tree used to hold a `useState(true)` in every
 * row, so every section unfolded on every visit and a collapse survived only
 * until the next route change. Now:
 *
 *  - a fresh viewer sees every section COLLAPSED (children not rendered);
 *  - expanding a section renders its children and persists the choice under a
 *    per-viewer localStorage key;
 *  - a remount (navigation / reload) restores the persisted layout in the
 *    first client commit, with no expanded→collapsed flash;
 *  - the layout is scoped to the viewer — a different user id starts collapsed.
 *
 * Rendered with the real component and real hook against jsdom localStorage;
 * only the server action, the user context, and the client logger are mocked.
 */

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { CollectionTreeNode } from "@/lib/content";

// The shared tests/mocks/lucide-react.js exports a fixed icon list that does
// not include the tree's icons; an unmocked one renders as `undefined` and
// React throws "Element type is invalid" at mount.
jest.mock("lucide-react", () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />;
  return {
    ChevronDown: Icon,
    ChevronRight: Icon,
    FolderOpen: Icon,
    GripVertical: Icon,
    Layers: Icon,
    Lock: Icon,
  };
});

jest.mock("@/lib/client-logger", () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
}));

const collectionTreeActionMock = jest.fn();
jest.mock("@/actions/db/atrium/collection-tree", () => ({
  collectionTreeAction: (...a: unknown[]) => collectionTreeActionMock(...a),
}));

let currentUserId: number | null = 7;
jest.mock("@/components/auth/user-provider", () => ({
  useUser: () => ({
    user: currentUserId === null ? null : { id: currentUserId },
    roles: [],
    loading: currentUserId === null,
  }),
}));

import { CollectionTree } from "@/components/atrium/CollectionTree";

function node(
  id: string,
  name: string,
  children: CollectionTreeNode[] = [],
  scope: "district" | "private" = "district"
): CollectionTreeNode {
  return {
    id,
    name,
    slug: id,
    scope,
    parentId: null,
    position: 0,
    navItemId: null,
    selectableForCreate: true,
    // Manageable, so the drag handle branch renders under test as well.
    canManage: true,
    visibleObjectCount: 0,
    children,
    // Fields the tree never reads, but the contract requires. Spelled out
    // rather than cast away so a change to CollectionTreeNode fails this file
    // at typecheck instead of drifting silently past these tests.
    ownerUserId: null,
    defaultVisibilityLevel: "internal",
    description: null,
    landingObjectId: null,
    hasHeroImage: false,
    heroImageAlt: null,
  };
}

const TREE: CollectionTreeNode[] = [
  node("parent-a", "Parent A", [node("child-a1", "Child A1")]),
  node("parent-b", "Parent B", [node("child-b1", "Child B1")]),
];

function renderTree() {
  return render(
    <CollectionTree selectedCollectionId={null} onSelect={() => {}} />
  );
}

beforeEach(() => {
  window.localStorage.clear();
  currentUserId = 7;
  collectionTreeActionMock.mockReset();
  collectionTreeActionMock.mockResolvedValue({
    isSuccess: true,
    message: "",
    data: TREE,
  });
});

afterEach(() => {
  cleanup();
});

describe("CollectionTree — collapsed by default, expansion persisted per viewer", () => {
  it("starts with every section collapsed (children not rendered)", async () => {
    renderTree();

    const expandA = await screen.findByRole("button", { name: "Expand Parent A" });
    expect(expandA).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Expand Parent B" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(screen.queryByText("Child A1")).not.toBeInTheDocument();
    expect(screen.queryByText("Child B1")).not.toBeInTheDocument();
  });

  it("expanding a section renders its children, flips the chevron, and persists under the viewer's key", async () => {
    renderTree();

    fireEvent.click(await screen.findByRole("button", { name: "Expand Parent A" }));

    expect(screen.getByText("Child A1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse Parent A" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
    // The sibling is untouched — expansion is per section, not global.
    expect(screen.queryByText("Child B1")).not.toBeInTheDocument();

    const stored = window.localStorage.getItem("atrium.expandedSections:7");
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string)).toEqual(["parent-a"]);
  });

  it("a remount restores the persisted layout (survives navigation / reload)", async () => {
    const first = renderTree();
    fireEvent.click(await screen.findByRole("button", { name: "Expand Parent A" }));
    expect(screen.getByText("Child A1")).toBeInTheDocument();
    first.unmount();

    renderTree();
    // Restored, not re-defaulted: Parent A is open, Parent B still closed.
    expect(await screen.findByText("Child A1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse Parent A" })).toBeInTheDocument();
    expect(screen.queryByText("Child B1")).not.toBeInTheDocument();
  });

  it("collapsing a section removes it from the persisted set", async () => {
    renderTree();
    fireEvent.click(await screen.findByRole("button", { name: "Expand Parent A" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse Parent A" }));

    expect(screen.queryByText("Child A1")).not.toBeInTheDocument();
    expect(
      JSON.parse(window.localStorage.getItem("atrium.expandedSections:7") as string)
    ).toEqual([]);
  });

  it("is scoped to the viewer — another user id starts collapsed on the same browser", async () => {
    const first = renderTree();
    fireEvent.click(await screen.findByRole("button", { name: "Expand Parent A" }));
    first.unmount();

    currentUserId = 8;
    renderTree();
    expect(await screen.findByRole("button", { name: "Expand Parent A" })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
    expect(screen.queryByText("Child A1")).not.toBeInTheDocument();
    // The first viewer's layout is untouched.
    expect(JSON.parse(window.localStorage.getItem("atrium.expandedSections:7") as string)).toEqual([
      "parent-a",
    ]);
    expect(window.localStorage.getItem("atrium.expandedSections:8")).toBeNull();
  });

  it("before the viewer is known, toggles are memory-only and never touch localStorage", async () => {
    currentUserId = null;
    renderTree();
    fireEvent.click(await screen.findByRole("button", { name: "Expand Parent A" }));

    expect(screen.getByText("Child A1")).toBeInTheDocument();
    expect(window.localStorage.length).toBe(0);
  });
});
