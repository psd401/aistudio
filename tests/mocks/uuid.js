/**
 * UUID mock for Jest tests
 *
 * The uuid package (v13+) is pure ESM and doesn't transform well with next/jest.
 * This mock provides the required v4() function for tests.
 */

let counter = 0;

function v5(value) {
  let hash = 0;
  for (const [index, character] of [...String(value)].entries()) {
    hash =
      (hash + (character.codePointAt(0) ?? 0) * (index + 1)) %
      0xFFFFFFFF;
  }
  const hex = hash.toString(16).padStart(8, '0');
  return `${hex}-${hex.slice(0, 4)}-5000-a000-${hex.padStart(12, '0')}`;
}

v5.URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
v5.DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

module.exports = {
  v4: () => {
    counter++;
    // Generate a predictable but unique-looking UUID for tests
    const hex = counter.toString(16).padStart(8, '0');
    return `${hex}-0000-4000-a000-000000000000`;
  },
  v5,
  // Reset counter for test isolation if needed
  __reset: () => { counter = 0; }
};
