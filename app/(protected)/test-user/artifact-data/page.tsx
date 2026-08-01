import { notFound } from "next/navigation";
import { ArtifactDataTestClient } from "./artifact-data-test-client";

/**
 * Local-only Server Action transport harness used by the authenticated
 * Playwright suite. It is deliberately unavailable in production builds.
 */
export default function ArtifactDataTestPage(): React.JSX.Element {
  if (process.env.NODE_ENV === "production") notFound();
  return <ArtifactDataTestClient />;
}
