/**
 * @jest-environment node
 *
 * Unit tests for resolveSessionMaxAge (REV-COR-248): a malformed SESSION_MAX_AGE
 * must fall back to the 24h default instead of passing NaN to NextAuth's session
 * config; a valid numeric value is honored.
 */

// auth.ts calls NextAuth(authConfig) at module load — mock it so importing the
// module is a pure, side-effect-free operation for this unit test.
jest.mock('next-auth', () => ({
  __esModule: true,
  default: jest.fn(() => ({ auth: jest.fn(), handlers: {}, signIn: jest.fn(), signOut: jest.fn() })),
}))
jest.mock('next-auth/providers/cognito', () => ({
  __esModule: true,
  default: jest.fn(() => ({})),
}))

// jest.setup.js globally mocks '@/auth'; load the REAL module here so we exercise
// the actual resolveSessionMaxAge implementation.
const { resolveSessionMaxAge } = jest.requireActual('@/auth') as typeof import('@/auth')

const DEFAULT = 24 * 60 * 60 // 86400

describe('resolveSessionMaxAge (REV-COR-248)', () => {
  it('returns the 24h default when unset', () => {
    expect(resolveSessionMaxAge(undefined)).toBe(DEFAULT)
    expect(resolveSessionMaxAge('')).toBe(DEFAULT)
  })

  it('honors a valid numeric value', () => {
    expect(resolveSessionMaxAge('3600')).toBe(3600)
    expect(resolveSessionMaxAge('86400')).toBe(86400)
  })

  it('falls back to the default for a fully non-numeric value', () => {
    expect(resolveSessionMaxAge('abc')).toBe(DEFAULT)
    expect(resolveSessionMaxAge('24h')).toBe(24) // parseInt('24h') === 24; still a positive int, honored
  })

  it('falls back to the default for zero / negative values', () => {
    expect(resolveSessionMaxAge('0')).toBe(DEFAULT)
    expect(resolveSessionMaxAge('-100')).toBe(DEFAULT)
  })

  it('never returns NaN', () => {
    for (const v of [undefined, '', 'abc', 'NaN', '   ', 'x99']) {
      expect(Number.isNaN(resolveSessionMaxAge(v))).toBe(false)
      expect(resolveSessionMaxAge(v)).toBeGreaterThan(0)
    }
  })
})
