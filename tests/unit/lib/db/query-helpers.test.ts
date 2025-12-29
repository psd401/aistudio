/**
 * Unit tests for type-safe query helpers
 *
 * Tests pure helper logic without database calls.
 * For database integration tests, see integration tests.
 */
import { describe, it, expect } from '@jest/globals'
import {
  // Pagination
  calculateOffset,
  buildPaginationMeta,
  createPaginatedResult,
  processCursorResults,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  // Search
  escapeSearchPattern,
  buildSearchPattern,
} from '@/lib/db/drizzle/helpers'

describe('Query Helpers - Pagination', () => {
  describe('calculateOffset', () => {
    it('should calculate correct offset for page 1', () => {
      const result = calculateOffset({ page: 1, limit: 10 })
      expect(result).toEqual({ offset: 0, limit: 10 })
    })

    it('should calculate correct offset for page 3', () => {
      const result = calculateOffset({ page: 3, limit: 20 })
      expect(result).toEqual({ offset: 40, limit: 20 })
    })

    it('should use default page size when not specified', () => {
      const result = calculateOffset({})
      expect(result.limit).toBe(DEFAULT_PAGE_SIZE)
      expect(result.offset).toBe(0)
    })

    it('should enforce max limit', () => {
      const result = calculateOffset({ page: 1, limit: 1000 })
      expect(result.limit).toBe(MAX_PAGE_SIZE)
    })

    it('should handle custom max limit', () => {
      const result = calculateOffset({ page: 1, limit: 100 }, 50)
      expect(result.limit).toBe(50)
    })

    it('should handle negative page numbers by using minimum', () => {
      const result = calculateOffset({ page: -5, limit: 10 })
      expect(result.offset).toBe(0) // page 1
    })

    it('should handle zero page number by using minimum', () => {
      const result = calculateOffset({ page: 0, limit: 10 })
      expect(result.offset).toBe(0) // page 1
    })

    it('should handle zero limit by using minimum of 1', () => {
      const result = calculateOffset({ page: 1, limit: 0 })
      expect(result.limit).toBe(1)
    })
  })

  describe('buildPaginationMeta', () => {
    it('should build correct metadata for first page', () => {
      const meta = buildPaginationMeta({ page: 1, limit: 25 }, 100)
      expect(meta).toEqual({
        page: 1,
        limit: 25,
        total: 100,
        totalPages: 4,
        hasNextPage: true,
        hasPreviousPage: false,
      })
    })

    it('should build correct metadata for middle page', () => {
      const meta = buildPaginationMeta({ page: 2, limit: 25 }, 100)
      expect(meta).toEqual({
        page: 2,
        limit: 25,
        total: 100,
        totalPages: 4,
        hasNextPage: true,
        hasPreviousPage: true,
      })
    })

    it('should build correct metadata for last page', () => {
      const meta = buildPaginationMeta({ page: 4, limit: 25 }, 100)
      expect(meta).toEqual({
        page: 4,
        limit: 25,
        total: 100,
        totalPages: 4,
        hasNextPage: false,
        hasPreviousPage: true,
      })
    })

    it('should handle empty results', () => {
      const meta = buildPaginationMeta({ page: 1, limit: 25 }, 0)
      expect(meta).toEqual({
        page: 1,
        limit: 25,
        total: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      })
    })

    it('should handle single page of results', () => {
      const meta = buildPaginationMeta({ page: 1, limit: 25 }, 10)
      expect(meta).toEqual({
        page: 1,
        limit: 25,
        total: 10,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      })
    })
  })

  describe('createPaginatedResult', () => {
    it('should create result with data and pagination', () => {
      const data = [{ id: 1 }, { id: 2 }, { id: 3 }]
      const result = createPaginatedResult(data, { page: 1, limit: 10 }, 3)

      expect(result.data).toEqual(data)
      expect(result.pagination.page).toBe(1)
      expect(result.pagination.total).toBe(3)
    })

    it('should handle empty data array', () => {
      const result = createPaginatedResult([], { page: 1, limit: 10 }, 0)

      expect(result.data).toEqual([])
      expect(result.pagination.total).toBe(0)
    })
  })

  describe('processCursorResults', () => {
    it('should detect more results when extra item present', () => {
      const results = [
        { id: 1, createdAt: new Date('2024-01-05') },
        { id: 2, createdAt: new Date('2024-01-04') },
        { id: 3, createdAt: new Date('2024-01-03') }, // Extra item
      ]
      const limit = 2

      const result = processCursorResults(results, limit, (item) => item.createdAt)

      expect(result.data).toHaveLength(2)
      expect(result.hasMore).toBe(true)
      expect(result.nextCursor).toEqual(new Date('2024-01-04'))
    })

    it('should detect no more results when at limit', () => {
      const results = [
        { id: 1, createdAt: new Date('2024-01-02') },
        { id: 2, createdAt: new Date('2024-01-01') },
      ]
      const limit = 2

      const result = processCursorResults(results, limit, (item) => item.createdAt)

      expect(result.data).toHaveLength(2)
      expect(result.hasMore).toBe(false)
      expect(result.nextCursor).toBeUndefined()
    })

    it('should handle empty results', () => {
      const result = processCursorResults([], 10, (item: { id: number }) => item.id)

      expect(result.data).toHaveLength(0)
      expect(result.hasMore).toBe(false)
      expect(result.nextCursor).toBeUndefined()
    })

    it('should handle fewer results than limit', () => {
      const results = [{ id: 1 }]
      const limit = 10

      const result = processCursorResults(results, limit, (item) => item.id)

      expect(result.data).toHaveLength(1)
      expect(result.hasMore).toBe(false)
    })
  })
})

describe('Query Helpers - Search', () => {
  describe('escapeSearchPattern', () => {
    it('should escape percent signs', () => {
      expect(escapeSearchPattern('100%')).toBe('100\\%')
    })

    it('should escape underscores', () => {
      expect(escapeSearchPattern('first_name')).toBe('first\\_name')
    })

    it('should escape backslashes', () => {
      expect(escapeSearchPattern('path\\to\\file')).toBe('path\\\\to\\\\file')
    })

    it('should escape multiple special characters', () => {
      expect(escapeSearchPattern('50% off_sale')).toBe('50\\% off\\_sale')
    })

    it('should leave regular text unchanged', () => {
      expect(escapeSearchPattern('hello world')).toBe('hello world')
    })
  })

  describe('buildSearchPattern', () => {
    it('should build contains pattern by default', () => {
      expect(buildSearchPattern('test')).toBe('%test%')
    })

    it('should build starts with pattern', () => {
      expect(buildSearchPattern('test', { startsWith: true })).toBe('test%')
    })

    it('should build ends with pattern', () => {
      expect(buildSearchPattern('test', { endsWith: true })).toBe('%test')
    })

    it('should build exact match pattern', () => {
      expect(buildSearchPattern('test', { exactMatch: true })).toBe('test')
    })

    it('should escape special characters in pattern', () => {
      expect(buildSearchPattern('50%')).toBe('%50\\%%')
    })

    it('should trim whitespace', () => {
      expect(buildSearchPattern('  test  ')).toBe('%test%')
    })
  })
})
