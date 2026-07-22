/**
 * Executes the synthesized unified-content Lambda artifact inside the same
 * Linux/ARM64 Node.js major version used by AWS Lambda. This catches dependency
 * and esbuild failures that source-level unit tests cannot observe.
 *
 * Prerequisite:
 *   cd infra && bunx cdk synth AIStudio-ProcessingStack-Dev
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as XLSX from "@e965/xlsx";
import { Document, Packer, Paragraph } from "docx";
import JSZip from "jszip";

const repositoryRoot = resolve(
  fileURLToPath(new URL("../..", import.meta.url))
);
const cdkOutput = join(repositoryRoot, "infra", "cdk.out");
const candidates = readdirSync(cdkOutput, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("asset."))
  .map((entry) => join(cdkOutput, entry.name))
  .filter((directory) => {
    const entry = join(directory, "index.mjs");
    return (
      existsSync(entry) &&
      readFileSync(entry, "utf8").includes("extractPdfTextForRuntimeSmoke")
    );
  })
  .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);

const assetDirectory = candidates[0];
if (!assetDirectory) {
  throw new Error(
    "No synthesized unified-content Lambda asset was found; synthesize AIStudio-ProcessingStack-Dev first"
  );
}
if (!existsSync(join(assetDirectory, "node_modules", "pdf-parse", "package.json"))) {
  throw new Error(
    `Synthesized artifact ${assetDirectory} does not contain the external pdf-parse runtime package`
  );
}

const fixtureDirectory = mkdtempSync(
  join(tmpdir(), "aistudio-unified-content-artifact-")
);
try {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const page = document.addPage([612, 792]);
  page.drawText(
    "Final Lambda artifact validation contains searchable district policy text.",
    { x: 50, y: 740, size: 12, font }
  );
  const fixturePath = join(fixtureDirectory, "runtime.pdf");
  writeFileSync(fixturePath, await document.save());
  const imagePath = join(fixtureDirectory, "runtime.png");
  writeFileSync(
    imagePath,
    Buffer.from(
      readFileSync(
        join(
          repositoryRoot,
          "tests",
          "fixtures",
          "unified-content",
          "images",
          "red-pixel.png.base64"
        ),
        "utf8"
      ).trim(),
      "base64"
    )
  );
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Department", "Procedure"],
      ["Operations", "Artifact office extraction validation"],
    ]),
    "Directory"
  );
  const officePath = join(fixtureDirectory, "runtime.xlsx");
  writeFileSync(
    officePath,
    XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Uint8Array
  );
  const docxPath = join(fixtureDirectory, "runtime.docx");
  writeFileSync(
    docxPath,
    await Packer.toBuffer(
      new Document({
        sections: [
          {
            children: [
              new Paragraph("Artifact DOCX extraction validation"),
            ],
          },
        ],
      })
    )
  );
  const presentation = new JSZip();
  presentation.file(
    "[Content_Types].xml",
    '<Types><Override ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>'
  );
  presentation.file(
    "ppt/slides/slide1.xml",
    '<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Artifact PPTX extraction validation</a:t></a:r></a:p></p:sld>'
  );
  const pptxPath = join(fixtureDirectory, "runtime.pptx");
  writeFileSync(
    pptxPath,
    await presentation.generateAsync({ type: "uint8array" })
  );

  const probe = [
    'import { readFile } from "node:fs/promises";',
    'const worker = await import("file:///var/task/index.mjs");',
    'const source = await readFile("/fixture/runtime.pdf");',
    "const extracted = await worker.extractPdfTextForRuntimeSmoke(source);",
    'if (extracted.pageCount !== 1) throw new Error("Unexpected PDF page count");',
    'if (!extracted.pages[0]?.text.includes("Final Lambda artifact validation")) throw new Error("PDF text was not extracted by the bundled runtime");',
    'const imageSource = await readFile("/fixture/runtime.png");',
    'const image = await worker.prepareRepositoryImageForRuntimeSmoke(imageSource, "image/png");',
    'if (image.width !== 4 || image.height !== 3 || image.thumbnail.byteLength === 0) throw new Error("Sharp image processing failed in the bundled runtime");',
    'const sharpModule = await import("file:///var/task/node_modules/sharp/lib/index.js"); const sharp = sharpModule.default;',
    'for (const [format, mediaType] of [["jpeg", "image/jpeg"], ["webp", "image/webp"], ["gif", "image/gif"], ["tiff", "image/tiff"]]) { const encoded = await sharp(imageSource).toFormat(format).toBuffer(); const prepared = await worker.prepareRepositoryImageForRuntimeSmoke(encoded, mediaType); if (prepared.detectedContentType !== mediaType || prepared.thumbnail.byteLength === 0) throw new Error(`Sharp ${format} processing failed in the bundled runtime`); }',
    'const officeSource = await readFile("/fixture/runtime.xlsx");',
    'const office = await worker.extractOfficeDocumentForRuntimeSmoke(officeSource, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");',
    'if (!office.canonicalText.includes("Artifact office extraction validation")) throw new Error("Office extraction failed in the bundled runtime");',
    'const docxSource = await readFile("/fixture/runtime.docx");',
    'const docx = await worker.extractOfficeDocumentForRuntimeSmoke(docxSource, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");',
    'if (!docx.canonicalText.includes("Artifact DOCX extraction validation")) throw new Error("DOCX extraction failed in the bundled runtime");',
    'const pptxSource = await readFile("/fixture/runtime.pptx");',
    'const pptx = await worker.extractOfficeDocumentForRuntimeSmoke(pptxSource, "application/vnd.openxmlformats-officedocument.presentationml.presentation");',
    'if (!pptx.canonicalText.includes("Artifact PPTX extraction validation")) throw new Error("PPTX extraction failed in the bundled runtime");',
    'const text = worker.extractCanonicalTextDocumentForRuntimeSmoke(new TextEncoder().encode("Artifact text extraction validation"), "text/plain", "runtime.txt");',
    'if (!text.canonicalText.includes("Artifact text extraction validation")) throw new Error("Text extraction failed in the bundled runtime");',
    'const markdown = worker.extractCanonicalTextDocumentForRuntimeSmoke(new TextEncoder().encode("# Policy\\n\\nArtifact markdown extraction validation"), "text/markdown", "runtime.md");',
    'if (markdown.segments[0]?.sourceLocator?.headingPath?.[1] !== "Policy") throw new Error("Markdown structure extraction failed in the bundled runtime");',
    'const csv = worker.extractCanonicalTextDocumentForRuntimeSmoke(new TextEncoder().encode("department,procedure\\nOperations,Artifact CSV extraction validation"), "text/csv", "runtime.csv");',
    'if (!csv.canonicalText.includes("Artifact CSV extraction validation")) throw new Error("CSV extraction failed in the bundled runtime");',
    'const media = worker.processBdaMediaOutputForRuntimeSmoke({ metadata: { semantic_modality: "AUDIO", duration_millis: 1000, format: "mp3" }, audio_segments: [{ start_timestamp_millis: 0, end_timestamp_millis: 1000, text: "Artifact media extraction validation" }] }, "audio");',
    'if (!media.canonicalText.includes("Artifact media extraction validation")) throw new Error("BDA media normalization failed in the bundled runtime");',
    'const video = worker.processBdaMediaOutputForRuntimeSmoke({ metadata: { semantic_modality: "VIDEO", duration_millis: 1000, format: "mp4", frame_rate: 30, frame_width: 1280, frame_height: 720 }, summary: "Artifact video extraction validation", frames: [{ timestamp_millis: 500, text_words: [{ text: "EXIT", locations: [{ bounding_box: { left: 0.1, top: 0.2, width: 0.3, height: 0.1 } }] }] }] }, "video");',
    'if (!video.canonicalText.includes("Artifact video extraction validation") || !video.canonicalText.includes("EXIT")) throw new Error("BDA video normalization failed in the bundled runtime");',
    'process.stdout.write("UNIFIED_CONTENT_LAMBDA_ARTIFACT_SMOKE_OK\\n");',
  ].join(" ");
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      "linux/arm64",
      "-e",
      "AWS_REGION=us-east-1",
      "-e",
      "NODE_PATH=/var/runtime/node_modules:/var/runtime:/var/task",
      "-e",
      "DOCUMENTS_BUCKET_NAME=artifact-smoke",
      "-e",
      "CONTENT_PROCESSING_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789012/content",
      "-e",
      "CONTENT_PROCESSING_DLQ_URL=https://sqs.us-east-1.amazonaws.com/123456789012/content-dlq",
      "-e",
      "EMBEDDING_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789012/embedding",
      "-e",
      "EMBEDDING_DLQ_URL=https://sqs.us-east-1.amazonaws.com/123456789012/embedding-dlq",
      "-e",
      "BDA_DATA_AUTOMATION_PROJECT_ARN=arn:aws:bedrock:us-east-1:123456789012:data-automation-project/artifact-smoke",
      "-e",
      "BDA_DATA_AUTOMATION_PROFILE_ARN=arn:aws:bedrock:us-east-1:123456789012:data-automation-profile/us.data-automation-v1",
      "-e",
      "DATABASE_HOST=database.invalid",
      "-e",
      "DATABASE_SECRET_ARN=arn:aws:secretsmanager:us-east-1:123456789012:secret:artifact-smoke",
      "-v",
      `${assetDirectory}:/var/task:ro`,
      "-v",
      `${fixtureDirectory}:/fixture:ro`,
      "--entrypoint",
      "/var/lang/bin/node",
      "public.ecr.aws/lambda/nodejs:20-arm64",
      "--input-type=module",
      "--eval",
      probe,
    ],
    { encoding: "utf8" }
  );

  if (
    result.status !== 0 ||
    !result.stdout.includes("UNIFIED_CONTENT_LAMBDA_ARTIFACT_SMOKE_OK")
  ) {
    throw new Error(
      [
        `Lambda artifact smoke failed with exit code ${result.status ?? "unknown"}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  process.stdout.write(result.stdout);
} finally {
  rmSync(fixtureDirectory, { recursive: true, force: true });
}
