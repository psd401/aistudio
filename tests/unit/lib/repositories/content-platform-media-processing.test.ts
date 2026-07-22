import {
  BDA_AUDIO_MAX_BYTES,
  BDA_VIDEO_MAX_BYTES,
  isMediaContentType,
  maximumMediaBytes,
  mediaArtifactObjectPrefix,
  mediaKindForContentType,
  parseS3Uri,
  processBdaMediaOutput,
} from "@/lib/repositories/content-platform/media-processing";

describe("canonical media processing", () => {
  it("recognizes the bounded BDA audio and video allowlists", () => {
    expect(mediaKindForContentType("audio/mpeg")).toBe("audio");
    expect(mediaKindForContentType("audio/x-m4a")).toBe("audio");
    expect(mediaKindForContentType("video/mp4")).toBe("video");
    expect(mediaKindForContentType("video/x-matroska")).toBe("video");
    expect(isMediaContentType("video/webm")).toBe(true);
    expect(isMediaContentType("application/vnd.apple.mpegurl")).toBe(false);
    expect(maximumMediaBytes("audio")).toBe(BDA_AUDIO_MAX_BYTES);
    expect(maximumMediaBytes("video")).toBe(BDA_VIDEO_MAX_BYTES);
  });

  it("creates stable, repository-scoped BDA object locations", () => {
    expect(
      mediaArtifactObjectPrefix(42, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"),
    ).toBe(
      "repositories/42/artifacts/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/bda/",
    );
    expect(
      parseS3Uri(
        "s3://documents/repositories/42/artifacts/version/bda/job.json",
      ),
    ).toEqual({
      bucket: "documents",
      key: "repositories/42/artifacts/version/bda/job.json",
    });
    expect(() => parseS3Uri("https://example.test/file.json")).toThrow(
      "invalid S3 URI",
    );
  });

  it("normalizes audio summaries, topics, speakers, channels, and exact times", () => {
    const processed = processBdaMediaOutput(
      {
        metadata: {
          semantic_modality: "AUDIO",
          duration_millis: 12_000,
          format: "mp3",
          codec: "mp3",
          number_of_channels: 2,
          dominant_asset_language: "EN",
        },
        summary: "A principal explains the emergency drill.",
        audio_segments: [
          {
            start_timestamp_millis: 100,
            end_timestamp_millis: 2_000,
            text: "Staff should lead students outside.",
            speaker: { speaker_label: "spk_0" },
            channel: { channel_label: "ch_0" },
          },
          {
            start_timestamp_millis: 2_100,
            end_timestamp_millis: 4_000,
            text: "Use the east assembly area.",
            speaker: { speaker_label: "spk_0" },
            channel: { channel_label: "ch_0" },
          },
        ],
        topics: [
          {
            start_timestamp_millis: 0,
            end_timestamp_millis: 6_000,
            summary: "Evacuation responsibilities and assembly locations.",
          },
        ],
        statistics: { word_count: 12, topic_count: 1 },
      },
      "audio",
    );

    expect(processed.metadata).toMatchObject({
      durationMs: 12_000,
      channels: 2,
      wordCount: 12,
      topicCount: 1,
    });
    expect(processed.segments).toHaveLength(3);
    expect(processed.segments[2]).toMatchObject({
      chunkIndex: 2,
      modality: "audio",
      sourceLocator: { timeStartMs: 100, timeEndMs: 4_000 },
    });
    expect(processed.segments[2]?.content).toContain("spk_0 / ch_0");
    expect(
      processed.segments.every((segment) =>
        /^[0-9a-f]{64}$/.test(segment.contentHash),
      ),
    ).toBe(true);
    expect(processed.transcriptText).toContain("[00:00:00.100–00:00:02.000]");
    expect(processed.canonicalText).toContain("## Topics");
    expect(processed.canonicalText).toContain("## Transcript");
  });

  it("normalizes wrapped video output into chapters, transcript, and cited frame OCR", () => {
    const processed = processBdaMediaOutput(
      {
        outputSegments: [
          {
            standardOutput: {
              metadata: {
                semantic_modality: "VIDEO",
                duration_millis: 20_000,
                format: "mp4",
                codec: "h264",
                frame_rate: 30,
                frame_width: 1920,
                frame_height: 1080,
              },
              summary: "A safety trainer demonstrates an evacuation route.",
              chapters: [
                {
                  start_timestamp_millis: 0,
                  end_timestamp_millis: 10_000,
                  summary: "The trainer introduces the east exit.",
                },
              ],
              audio_segments: [
                {
                  start_timestamp_millis: 500,
                  end_timestamp_millis: 2_500,
                  text: "Follow the green arrows.",
                  speaker: { speaker_label: "speaker_0" },
                },
              ],
              frames: [
                {
                  timestamp_millis: 3_500,
                  text_words: [
                    {
                      text: "EAST EXIT",
                      locations: [
                        {
                          bounding_box: {
                            left: 0.1,
                            top: 0.2,
                            width: 0.3,
                            height: 0.1,
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
              statistics: {
                shot_count: 4,
                chapter_count: 1,
                speaker_count: 1,
              },
            },
          },
        ],
      },
      "video",
    );

    expect(processed.metadata).toMatchObject({
      durationMs: 20_000,
      frameRate: 30,
      frameWidth: 1920,
      frameHeight: 1080,
      shotCount: 4,
      chapterCount: 1,
    });
    expect(processed.segments.map((segment) => segment.chunkIndex)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(processed.segments[3]).toMatchObject({
      modality: "video",
      sourceLocator: {
        timeStartMs: 3_500,
        timeEndMs: 3_500,
        regions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.1 }],
      },
    });
    expect(processed.segments[3]?.content).toBe("On-screen text: EAST EXIT");
    expect(processed.canonicalText).toContain("## Chapters");
    expect(processed.canonicalText).toContain("## On-screen text");
  });

  it("rejects modality mismatches and malformed output", () => {
    expect(() =>
      processBdaMediaOutput(
        { metadata: { semantic_modality: "AUDIO", duration_millis: 1_000 } },
        "video",
      ),
    ).toThrow("returned audio output for video");
    expect(() => processBdaMediaOutput({}, "audio")).toThrow(
      "does not contain media standard output",
    );
  });
});
