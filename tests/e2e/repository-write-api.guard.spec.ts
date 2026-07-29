import { expect, test } from "./fixtures";

const REPOSITORY_ID = 1;
const SESSION_ID = "11111111-2222-4333-8444-555555555555";

test.describe("Repository write API — unauthenticated guards", () => {
  test("upload initiation requires authentication before body validation", async ({
    request,
  }) => {
    const response = await request.post(
      `/api/v1/repositories/${REPOSITORY_ID}/items/uploads`,
      {
        data: {
          itemName: "Probe",
          fileName: "probe.pdf",
          contentType: "application/pdf",
          byteSize: 1,
        },
      },
    );

    expect(response.status()).toBe(401);
  });

  test("upload completion requires authentication before session lookup", async ({
    request,
  }) => {
    const response = await request.post(
      `/api/v1/repositories/${REPOSITORY_ID}/items/uploads/${SESSION_ID}/complete`,
      { data: {} },
    );

    expect(response.status()).toBe(401);
  });
});
