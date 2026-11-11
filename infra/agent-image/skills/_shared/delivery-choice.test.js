'use strict';

/**
 * The private-by-default rule every media skill shares (#2034): no flag means
 * private, and a public link needs `--to public` AND `--public-confirmed`.
 */

const { test, expect } = require('bun:test');

const {
  DeliveryChoiceError,
  driveFileName,
  PUBLIC_NEEDS_CONFIRMATION_MESSAGE,
  resolveDelivery,
} = require('./delivery-choice');

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(DeliveryChoiceError);
    return err.code;
  }
  throw new Error('expected a DeliveryChoiceError');
}

test('no flag is the private default', () => {
  expect(resolveDelivery({})).toBe('drive');
});

test('the first allowed destination is the default', () => {
  expect(resolveDelivery({}, { allowed: ['drive', 'file', 'public'] })).toBe('drive');
});

test('--to public alone is refused', () => {
  expect(codeOf(() => resolveDelivery({ to: 'public' }))).toBe(
    'public_needs_confirmation'
  );
});

test('--to public with --public-confirmed is public', () => {
  expect(resolveDelivery({ to: 'public', public_confirmed: true })).toBe('public');
});

test('--public-confirmed alone changes nothing', () => {
  expect(resolveDelivery({ public_confirmed: true })).toBe('drive');
});

test('--public-confirmed takes no value', () => {
  expect(
    codeOf(() => resolveDelivery({ to: 'public', public_confirmed: 'yes' }))
  ).toBe('bad_args');
});

test('an unknown or valueless destination is bad_args', () => {
  expect(codeOf(() => resolveDelivery({ to: 'everyone' }))).toBe('bad_args');
  expect(codeOf(() => resolveDelivery({ to: true }))).toBe('bad_args');
});

test('a destination the skill does not offer is bad_args', () => {
  expect(codeOf(() => resolveDelivery({ to: 'file' }))).toBe('bad_args');
});

test('the refusal tells the agent to ask the user in plain words', () => {
  expect(PUBLIC_NEEDS_CONFIRMATION_MESSAGE).toContain('without signing in');
  expect(PUBLIC_NEEDS_CONFIRMATION_MESSAGE).toContain('--public-confirmed');
  expect(PUBLIC_NEEDS_CONFIRMATION_MESSAGE).toContain('Nothing was uploaded');
});

test('driveFileName cleans a title to the broker-safe set', () => {
  expect(driveFileName('Board recap: Nov/11', '.png', 'Image')).toBe(
    'Board recap Nov 11.png'
  );
  expect(driveFileName('hero.png', '.png', 'Image')).toBe('hero.png');
});

test('driveFileName falls back to a dated name', () => {
  expect(
    driveFileName(undefined, '.mp4', 'Video', new Date(2026, 10, 11, 6, 5))
  ).toBe('Video 2026-11-11 0605.mp4');
  expect(driveFileName(true, '.mp4', 'Video', new Date(2026, 10, 11, 6, 5))).toBe(
    'Video 2026-11-11 0605.mp4'
  );
  expect(driveFileName('::', '.mp4', 'Video', new Date(2026, 10, 11, 6, 5))).toBe(
    'Video 2026-11-11 0605.mp4'
  );
});
