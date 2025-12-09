/**
 * Unit tests for logger circular reference detection and depth limiting
 * Issue #510: Navigation API endpoint crashes with stack overflow under load
 */

import { sanitizeForLogging } from '../logger'

describe('Logger Circular Reference Detection', () => {
  describe('sanitizeForLogging - Circular Objects', () => {
    it('should handle direct circular object reference', () => {
      const obj: Record<string, unknown> = { name: 'test' }
      obj.self = obj // Circular reference

      const result = sanitizeForLogging(obj)

      expect(result).toBeDefined()
      expect(result).toHaveProperty('name', 'test')
      // Circular reference should be replaced with '[Circular]'
      expect((result as Record<string, unknown>).self).toBe('[Circular]')
    })

    it('should handle two-node circular reference (A → B → A)', () => {
      const objA: Record<string, unknown> = { name: 'A' }
      const objB: Record<string, unknown> = { name: 'B' }
      objA.child = objB
      objB.parent = objA // Circular

      const result = sanitizeForLogging(objA) as Record<string, unknown>

      expect(result).toHaveProperty('name', 'A')
      expect(result).toHaveProperty('child')
      const child = result.child as Record<string, unknown>
      expect(child).toHaveProperty('name', 'B')
      // Circular reference should be detected
      expect(child.parent).toBe('[Circular]')
    })

    it('should handle multi-node cycle (A → B → C → A)', () => {
      const objA: Record<string, unknown> = { name: 'A' }
      const objB: Record<string, unknown> = { name: 'B' }
      const objC: Record<string, unknown> = { name: 'C' }
      objA.child = objB
      objB.child = objC
      objC.parent = objA // Circular

      const result = sanitizeForLogging(objA)

      expect(result).toBeDefined()
      // Should not throw stack overflow
    })

    it('should handle circular array references', () => {
      const arr: unknown[] = [1, 2, 3]
      arr.push(arr) // Circular reference

      const result = sanitizeForLogging(arr)

      expect(Array.isArray(result)).toBe(true)
      expect((result as unknown[])[0]).toBe(1)
      expect((result as unknown[])[1]).toBe(2)
      expect((result as unknown[])[2]).toBe(3)
      expect((result as unknown[])[3]).toBe('[Circular]')
    })

    it('should handle Error objects with circular references', () => {
      const error = new Error('Test error')
      ;(error as unknown as Record<string, unknown>).circular = error

      const result = sanitizeForLogging(error)

      expect(result).toHaveProperty('message', 'Test error')
      expect(result).toHaveProperty('name', 'Error')
      // Should not throw stack overflow
    })

    it('should handle complex nested objects with multiple circular refs', () => {
      const root: Record<string, unknown> = { name: 'root' }
      const child1: Record<string, unknown> = { name: 'child1' }
      const child2: Record<string, unknown> = { name: 'child2' }

      root.children = [child1, child2]
      child1.parent = root
      child2.parent = root
      child1.sibling = child2
      child2.sibling = child1

      const result = sanitizeForLogging(root)

      expect(result).toBeDefined()
      // Should handle multiple circular paths without stack overflow
    })
  })

  describe('sanitizeForLogging - Depth Limiting', () => {
    function createDeeplyNestedObject(depth: number): Record<string, unknown> {
      let obj: Record<string, unknown> = { value: depth }
      for (let i = depth - 1; i >= 0; i--) {
        obj = { level: i, child: obj }
      }
      return obj
    }

    it('should handle deeply nested objects within limit (10 levels)', () => {
      const deepObj = createDeeplyNestedObject(10)

      const result = sanitizeForLogging(deepObj)

      expect(result).toBeDefined()
      expect(result).toHaveProperty('level', 0)
    })

    it('should truncate at max depth (default 10)', () => {
      const deepObj = createDeeplyNestedObject(20)

      const result = sanitizeForLogging(deepObj)

      expect(result).toBeDefined()
      // Should truncate somewhere around depth 10
    })

    it('should handle extremely deep nesting without stack overflow (100 levels)', () => {
      const deepObj = createDeeplyNestedObject(100)

      expect(() => sanitizeForLogging(deepObj)).not.toThrow()
    })

    it('should handle 1000-level deep nesting without crashing', () => {
      const deepObj = createDeeplyNestedObject(1000)

      expect(() => sanitizeForLogging(deepObj)).not.toThrow()
    })
  })

  describe('sanitizeForLogging - Error Object Handling', () => {
    it('should skip Error.cause property to prevent infinite error chains', () => {
      const error1 = new Error('Error 1')
      const error2 = new Error('Error 2')
      ;(error1 as Error & { cause?: Error }).cause = error2
      ;(error2 as Error & { cause?: Error }).cause = error1 // Circular error chain

      const result = sanitizeForLogging(error1)

      expect(result).toHaveProperty('message', 'Error 1')
      expect(result).toHaveProperty('name', 'Error')
      // Should not include 'cause' property
      expect(result).not.toHaveProperty('cause')
    })

    it('should handle Error objects with deeply nested custom properties', () => {
      const error = new Error('Test error')
      ;(error as unknown as Record<string, unknown>).details = createDeeplyNestedObject(50)

      expect(() => sanitizeForLogging(error)).not.toThrow()
    })

    it('should handle AWS SDK errors with circular internal references', () => {
      const awsError = new Error('AWS SDK Error')
      ;(awsError as unknown as Record<string, unknown>).name = 'CredentialsProviderError'
      ;(awsError as unknown as Record<string, unknown>).request = {
        region: 'us-east-1',
        operation: 'executeStatement'
      }
      // Simulate AWS SDK circular reference pattern
      const request = (awsError as unknown as Record<string, unknown>).request as Record<string, unknown>
      request.error = awsError

      const result = sanitizeForLogging(awsError)

      expect(result).toBeDefined()
      expect(result).toHaveProperty('name', 'CredentialsProviderError')
    })
  })

  describe('sanitizeForLogging - Edge Cases', () => {
    it('should handle null and undefined', () => {
      expect(sanitizeForLogging(null)).toBeNull()
      expect(sanitizeForLogging(undefined)).toBeUndefined()
    })

    it('should handle primitive types', () => {
      expect(sanitizeForLogging('string')).toBe('string')
      expect(sanitizeForLogging(123)).toBe(123)
      expect(sanitizeForLogging(true)).toBe(true)
    })

    it('should handle empty objects and arrays', () => {
      expect(sanitizeForLogging({})).toEqual({})
      expect(sanitizeForLogging([])).toEqual([])
    })

    it('should handle Map and Set with circular references', () => {
      const map = new Map()
      map.set('self', map)

      expect(() => sanitizeForLogging(map)).not.toThrow()
    })

    it('should handle objects with __proto__, constructor, prototype keys', () => {
      const obj = {
        __proto__: { malicious: 'value' },
        constructor: 'fake',
        prototype: 'fake',
        normal: 'value'
      }

      const result = sanitizeForLogging(obj) as Record<string, unknown>

      // Should exclude dangerous keys
      expect(result).toHaveProperty('normal', 'value')
      expect(result).not.toHaveProperty('__proto__')
      expect(result).not.toHaveProperty('constructor')
      expect(result).not.toHaveProperty('prototype')
    })

    it('should handle objects with numeric keys', () => {
      const obj = { 0: 'zero', 1: 'one', name: 'test' }

      const result = sanitizeForLogging(obj)

      expect(result).toBeDefined()
    })

    it('should handle large arrays (10,000 items)', () => {
      const largeArray = Array.from({ length: 10000 }, (_, i) => ({
        id: i,
        name: `Item ${i}`
      }))

      expect(() => sanitizeForLogging(largeArray)).not.toThrow()
    })
  })

  describe('sanitizeForLogging - Performance', () => {
    it('should complete within reasonable time for complex objects', () => {
      const complexObj = {
        users: Array.from({ length: 100 }, (_, i) => ({
          id: i,
          name: `User ${i}`,
          roles: ['admin', 'user'],
          metadata: { createdAt: new Date().toISOString() }
        })),
        navigation: Array.from({ length: 50 }, (_, i) => ({
          id: i,
          label: `Nav ${i}`,
          children: Array.from({ length: 5 }, (_, j) => ({
            id: `${i}-${j}`,
            label: `Child ${j}`
          }))
        }))
      }

      const startTime = Date.now()
      const result = sanitizeForLogging(complexObj)
      const endTime = Date.now()

      expect(result).toBeDefined()
      // Should complete in less than 1 second
      expect(endTime - startTime).toBeLessThan(1000)
    })
  })

  describe('sanitizeForLogging - Security', () => {
    it('should prevent prototype pollution attempts', () => {
      const maliciousObj = JSON.parse('{"__proto__": {"polluted": true}}')

      const result = sanitizeForLogging(maliciousObj)

      // Should not include __proto__ in result
      expect(result).not.toHaveProperty('__proto__')
    })

    it('should sanitize strings for log injection', () => {
      const maliciousString = 'Normal text\nFAKE LOG ENTRY: [ERROR]'

      const result = sanitizeForLogging(maliciousString)

      // Should replace newlines with spaces
      expect(result).not.toContain('\n')
      expect(result).toContain('Normal text FAKE LOG ENTRY')
    })

    it('should limit string length to prevent log bloat', () => {
      const longString = 'A'.repeat(10000)

      const result = sanitizeForLogging(longString)

      expect(typeof result).toBe('string')
      expect((result as string).length).toBeLessThanOrEqual(1000)
    })
  })
})

function createDeeplyNestedObject(depth: number): Record<string, unknown> {
  let obj: Record<string, unknown> = { value: depth }
  for (let i = depth - 1; i >= 0; i--) {
    obj = { level: i, child: obj }
  }
  return obj
}
