import { NextResponse } from "next/server";
import { isLegacyContentRetirementActive } from "./legacy-retirement";

export async function legacyContentRetirementResponse(): Promise<NextResponse | null> {
  if (!(await isLegacyContentRetirementActive())) return null;
  return NextResponse.json(
    {
      code: "LEGACY_CONTENT_RETIRED",
      error:
        "This legacy document-processing endpoint has been retired. Use canonical repository ingestion.",
    },
    { status: 410 },
  );
}
