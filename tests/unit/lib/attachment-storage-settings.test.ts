/** @jest-environment node */

jest.mock("@aws-sdk/client-s3", () => ({
  S3Client: jest.fn(() => ({ send: jest.fn(() => Promise.resolve({})) })),
  PutObjectCommand: jest.fn((input: Record<string, unknown>) => ({ input })),
  GetObjectCommand: jest.fn((input: Record<string, unknown>) => ({ input })),
}));

jest.mock("@/lib/settings-manager", () => ({
  Settings: {
    getS3: jest.fn(() =>
      Promise.resolve({ bucket: "database-documents", region: "us-east-1" })
    ),
  },
}));

import { PutObjectCommand } from "@aws-sdk/client-s3";
import { Settings } from "@/lib/settings-manager";
import { storeAttachmentInS3 } from "@/lib/services/attachment-storage-service";

const mockGetS3 = jest.mocked(Settings.getS3);
const mockPutObjectCommand = jest.mocked(PutObjectCommand);

describe("attachment storage configuration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("resolves the documents bucket from database-first settings at request time", async () => {
    await storeAttachmentInS3(
      "conversation-id",
      "message-id",
      {
        id: "attachment-id",
        name: "photo.png",
        type: "image",
        contentType: "image/png",
        image: "data:image/png;base64,iVBORw0KGgo=",
      },
      0
    );

    expect(mockGetS3).toHaveBeenCalledTimes(1);
    expect(mockPutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({ Bucket: "database-documents" })
    );
  });
});
