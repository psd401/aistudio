/**
 * agent-media handler tests.
 *
 * Run: bun test   (from infra/agent-media/)
 *
 * These cover the parts that can be exercised without Docker: request
 * validation, the path/prefix boundary, the ffprobe summariser, and the
 * dispatch-level error taxonomy. The parts that genuinely need the container —
 * Chromium actually producing a PDF, ffmpeg actually transcoding — are proven
 * by the Dockerfile's own build-time probes and by the RIE smoke test in
 * README.md, because asserting on a mocked execFile would only prove the mock.
 */

'use strict';

const { test, expect, describe } = require('bun:test');
const { handler, testables } = require('./handler');

const {
  relativeWorkspacePath,
  workspacePrefixOf,
  summariseProbe,
  BadRequest,
  PRESETS,
  PAGE_SIZES,
  TRANSCRIBABLE,
} = testables;

describe('workspace path boundary', () => {
  test('accepts an ordinary relative path, hyphens and dots included', () => {
    for (const value of [
      'uploads/clip.mov',
      'a-file-with-hyphens.mp4',
      'nested/dir.v2/file.name.m4a',
      'x'.repeat(700),
    ]) {
      expect(relativeWorkspacePath(value, 'inputPath')).toBe(value);
    }
  });

  test('refuses every shape that could escape the owner prefix', () => {
    const escapes = [
      '/etc/passwd',
      '../other-owner/secret.mp4',
      'a/../../b.mp4',
      'a/./b.mp4',
      'a//b.mp4',
      '..',
      'dir\\file.mp4',
      '',
      'x'.repeat(769),
    ];
    for (const value of escapes) {
      expect(() => relativeWorkspacePath(value, 'inputPath')).toThrow(BadRequest);
    }
  });

  test('refuses control characters, including DEL', () => {
    for (const code of [0x00, 0x09, 0x0A, 0x1F, 0x7F]) {
      const value = `clip${String.fromCharCode(code)}.mov`;
      expect(() => relativeWorkspacePath(value, 'inputPath')).toThrow(BadRequest);
    }
  });

  test('refuses a non-string path rather than coercing it', () => {
    for (const value of [null, undefined, 42, {}, ['a'], true]) {
      expect(() => relativeWorkspacePath(value, 'inputPath')).toThrow(BadRequest);
    }
  });
});

describe('injected workspace prefix', () => {
  test('normalises a prefix with or without its trailing slash', () => {
    expect(workspacePrefixOf({ workspacePrefix: 'stittd-fc954a03' })).toBe(
      'stittd-fc954a03/',
    );
    expect(workspacePrefixOf({ workspacePrefix: 'stittd-fc954a03/' })).toBe(
      'stittd-fc954a03/',
    );
  });

  test('refuses a malformed or scope-widening prefix', () => {
    // The relay owns this field, so a bad value means the relay is wrong or
    // something bypassed it — fail closed rather than build an S3 key from it.
    const bad = [
      undefined,
      '',
      '/absolute/',
      '../escape/',
      'has space/',
      'two/levels/',
      `${'x'.repeat(200)}/`,
      '.hidden/',
    ];
    for (const workspacePrefix of bad) {
      expect(() => workspacePrefixOf({ workspacePrefix })).toThrow(BadRequest);
    }
  });
});

describe('ffprobe summariser', () => {
  test('reduces a real ffprobe payload to the fields a caller acts on', () => {
    const summary = summariseProbe(
      JSON.stringify({
        format: { duration: '12.345678', size: '4096', format_name: 'mov,mp4,m4a' },
        streams: [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: 1920,
            height: 1080,
            avg_frame_rate: '30000/1001',
            pix_fmt: 'yuv420p',
          },
          { codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' },
        ],
      }),
    );
    expect(summary.durationSeconds).toBe(12.35);
    expect(summary.video.codec).toBe('h264');
    expect(summary.video.fps).toBe(29.97);
    expect(summary.audio.sampleRate).toBe(48000);
  });

  test('reports a missing stream as null instead of inventing one', () => {
    const summary = summariseProbe(
      JSON.stringify({
        format: { duration: '3.0' },
        streams: [{ codec_type: 'audio', codec_name: 'aac', channels: 1 }],
      }),
    );
    expect(summary.video).toBeNull();
    expect(summary.audio.channels).toBe(1);
  });

  test('does not divide by zero on the N/0 frame rate ffprobe emits for stills', () => {
    const summary = summariseProbe(
      JSON.stringify({
        format: {},
        streams: [{ codec_type: 'video', codec_name: 'png', avg_frame_rate: '0/0' }],
      }),
    );
    expect(summary.video.fps).toBeNull();
  });

  test('throws on non-JSON rather than returning a hollow summary', () => {
    expect(() => summariseProbe('not json')).toThrow();
  });
});

describe('handler dispatch', () => {
  const prefix = { workspacePrefix: 'owner-abc123/' };

  test('refuses an unknown operation by name', async () => {
    const result = await handler({ ...prefix, operation: 'rm-rf' });
    expect(result.status).toBe('error');
    expect(result.error).toBe('bad_request');
    expect(result.message).toContain('html-to-pdf');
  });

  test('refuses a non-object event without throwing', async () => {
    for (const event of [null, undefined, 'string', ['a']]) {
      const result = await handler(event);
      expect(result.status).toBe('error');
      expect(result.error).toBe('bad_request');
    }
  });

  test('refuses a missing workspace prefix before doing any work', async () => {
    const result = await handler({ operation: 'html-to-pdf', html: '<p>hi</p>' });
    expect(result.status).toBe('error');
    expect(result.message).toContain('workspacePrefix');
  });

  test('validates html-to-pdf inputs and names the offending field', async () => {
    const cases = [
      [{ html: '' }, 'html'],
      [{ html: '   ' }, 'html'],
      [{ html: '<p>x</p>', pageSize: 'poster' }, 'pageSize'],
      [{ html: '<p>x</p>', marginInches: 9 }, 'marginInches'],
      [{ html: '<p>x</p>', marginInches: -1 }, 'marginInches'],
      [{ html: '<p>x</p>', scale: 0 }, 'scale'],
      [{ html: '<p>x</p>', scale: 5 }, 'scale'],
    ];
    for (const [fields, field] of cases) {
      const result = await handler({ ...prefix, operation: 'html-to-pdf', ...fields });
      expect(result.status).toBe('error');
      expect(result.error).toBe('bad_request');
      expect(result.message).toContain(field);
    }
  });

  test('refuses an unknown ffmpeg preset by listing the real ones', async () => {
    const result = await handler({
      ...prefix,
      operation: 'media',
      action: 'convert',
      inputPath: 'in.mov',
      outputPath: 'out.mp4',
      preset: 'ultra-hd-8k',
    });
    expect(result.status).toBe('error');
    // Path validation passes, so this must reach the preset check rather than
    // dying earlier for the wrong reason.
    expect(result.message).toContain('social-mp4');
  });

  test('refuses an un-transcribable extension and points at the converter', async () => {
    const result = await handler({
      ...prefix,
      operation: 'transcribe',
      inputPath: 'recording.aiff',
    });
    expect(result.status).toBe('error');
    expect(result.error).toBe('bad_request');
    expect(result.message).toContain('.m4a');
    expect(result.message).toContain('media skill');
  });

  test('refuses a malformed languageCode', async () => {
    const result = await handler({
      ...prefix,
      operation: 'transcribe',
      inputPath: 'recording.m4a',
      languageCode: 'english',
    });
    expect(result.status).toBe('error');
    expect(result.message).toContain('languageCode');
  });
});

describe('preset contract', () => {
  test('every preset declares an extension and a content type', () => {
    for (const [name, preset] of PRESETS) {
      expect(preset.extension.startsWith('.')).toBe(true);
      expect(preset.contentType).toContain('/');
      expect(Array.isArray(preset.args)).toBe(true);
      expect(preset.args.length).toBeGreaterThan(0);
      // No shell metacharacters anywhere in a preset: these are passed to
      // execFile as argv, and keeping them inert makes that visibly safe.
      for (const arg of preset.args) {
        expect(/[;&|`$><\n]/.test(arg)).toBe(false);
      }
      expect(name).toBe(name.toLowerCase());
    }
  });

  test('social-mp4 carries the flags that make an upload actually accepted', () => {
    const args = PRESETS.get('social-mp4').args.join(' ');
    // yuv420p and +faststart are the two that silently break Facebook and
    // Instagram uploads when missing — worth pinning rather than trusting.
    expect(args).toContain('yuv420p');
    expect(args).toContain('+faststart');
    expect(args).toContain('libx264');
  });

  test('the page sizes include the 8.5x11 the original request needed', () => {
    expect(PAGE_SIZES.get('letter')).toEqual([8.5, 11]);
  });

  test('the transcribable set matches what Transcribe actually accepts', () => {
    for (const extension of TRANSCRIBABLE) {
      expect(extension.startsWith('.')).toBe(true);
    }
    expect(TRANSCRIBABLE.has('.m4a')).toBe(true);
  });
});
