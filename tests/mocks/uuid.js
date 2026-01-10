/**
 * UUID mock for Jest tests
 *
 * The uuid package (v13+) is pure ESM and doesn't transform well with next/jest.
 * This mock provides the required v4() function for tests.
 */

let counter = 0;

module.exports = {
  v4: () => {
    counter++;
    // Generate a predictable but unique-looking UUID for tests
    const hex = counter.toString(16).padStart(8, '0');
    return `${hex}-0000-4000-a000-000000000000`;
  },
  // Reset counter for test isolation if needed
  __reset: () => { counter = 0; }
};
