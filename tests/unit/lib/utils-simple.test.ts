import { describe, it, expect } from '@jest/globals'

describe('Simple Utility Functions', () => {
  it('should perform basic string operations', () => {
    const testString = 'hello world'
    expect(testString.toUpperCase()).toBe('HELLO WORLD')
    expect(testString.length).toBe(11)
    expect(testString.includes('world')).toBe(true)
  })

  it('should perform basic array operations', () => {
    const testArray = [1, 2, 3, 4, 5]
    expect(testArray.length).toBe(5)
    expect(testArray.includes(3)).toBe(true)
    expect(testArray.map(x => x * 2)).toEqual([2, 4, 6, 8, 10])
  })

  it('should perform basic object operations', () => {
    const testObject = { name: 'John', age: 30 }
    expect(testObject.name).toBe('John')
    expect(Object.keys(testObject)).toEqual(['name', 'age'])
    expect(Object.values(testObject)).toEqual(['John', 30])
  })

  it('should handle basic number operations', () => {
    expect(2 + 2).toBe(4)
    expect(10 - 5).toBe(5)
    expect(3 * 4).toBe(12)
    expect(15 / 3).toBe(5)
  })

  it('should handle date operations', () => {
    const date = new Date(2023, 0, 1) // Year, month (0-based), day
    expect(date.getFullYear()).toBe(2023)
    expect(date.getMonth()).toBe(0) // January is 0
    expect(date.getDate()).toBe(1)
  })

  it('should handle JSON operations', () => {
    const obj = { test: 'value', number: 42 }
    const json = JSON.stringify(obj)
    const parsed = JSON.parse(json)
    expect(parsed).toEqual(obj)
    expect(json).toBe('{"test":"value","number":42}')
  })

  it('should handle promise operations', async () => {
    const promise = Promise.resolve('test value')
    const result = await promise
    expect(result).toBe('test value')
  })
})
