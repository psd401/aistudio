import {
  assetIdFromBytesPath,
  contentAssetBytesPath,
  parseContentAssetDirectiveAttrs,
  parseContentAssetIds,
  serializeContentAssetDirective,
} from "@/lib/content/asset-directive";
import { isSafeMediaUrl } from "@/lib/content/block-directives";

const ASSET_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("Atrium immutable asset directives (#1284)", () => {
  it("round-trips the canonical directive and same-origin byte URL", () => {
    expect(serializeContentAssetDirective(ASSET_ID, 'Plan "A"\npreview')).toBe(
      `::atrium-asset{id="${ASSET_ID}" alt="Plan  A  preview"}`
    );
    expect(
      parseContentAssetDirectiveAttrs(
        `id="${ASSET_ID}" alt="Accessible diagram"`
      )
    ).toEqual({ assetId: ASSET_ID, alt: "Accessible diagram" });
    const path = contentAssetBytesPath(ASSET_ID);
    expect(path).toBe(`/api/v1/content/assets/${ASSET_ID}/bytes`);
    expect(assetIdFromBytesPath(path ?? "")).toBe(ASSET_ID);
    expect(isSafeMediaUrl(path ?? "")).toBe(true);
  });

  it("collects unique references in source order while ignoring fenced code", () => {
    const markdown = [
      `::atrium-asset{id="${ASSET_ID}" alt="first"}`,
      "```markdown",
      `::atrium-asset{id="${OTHER_ID}" alt="not live"}`,
      "```",
      `::atrium-asset{id="${ASSET_ID}" alt="duplicate"}`,
      `::atrium-asset{id="${OTHER_ID}" alt="second"}`,
    ].join("\n");
    expect(parseContentAssetIds(markdown)).toEqual([ASSET_ID, OTHER_ID]);
  });

  it("rejects malformed ids, unsafe byte paths, and mid-line pseudo-directives", () => {
    expect(serializeContentAssetDirective("../secret", "x")).toBeNull();
    expect(
      parseContentAssetDirectiveAttrs(`id="../../secret" alt="x"`)
    ).toBeNull();
    expect(
      isSafeMediaUrl(`/api/v1/content/assets/${ASSET_ID}/bytes?download=1`)
    ).toBe(false);
    expect(
      parseContentAssetIds(
        `not a block ::atrium-asset{id="${ASSET_ID}" alt="x"}`
      )
    ).toEqual([]);
  });
});
