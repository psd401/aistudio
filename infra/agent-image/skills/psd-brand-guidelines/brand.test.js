'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadConfig, validatePrompt } = require('./brand');

const config = loadConfig();

test('validatePrompt blocks bundled logo and emblem generation patterns', () => {
  for (const prompt of [
    'Generate a PSD logo for the event',
    'Please create the district emblem',
    'Draw a school logo',
    'Use the Peninsula seal',
  ]) {
    const result = validatePrompt(config, prompt);
    assert.equal(result.valid, false, prompt);
    assert.match(result.errors[0], /^Blocked:/);
  }
});

test('validatePrompt allows ordinary brand asset requests', () => {
  for (const prompt of [
    'Place the official PSD logo in the footer',
    'Use Peninsula School District blue',
    'Find the approved horizontal logo asset',
  ]) {
    assert.deepEqual(validatePrompt(config, prompt), {
      valid: true,
      errors: [],
    });
  }
});
