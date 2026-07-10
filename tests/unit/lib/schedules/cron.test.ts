/**
 * @jest-environment node
 *
 * Cron conversion for Assistant Architect schedules:
 *   REV-COR-046 — weekly day-of-week must map UI 0=SUN..6=SAT to AWS 1=SUN..7=SAT.
 *   REV-COR-047 — custom 5-field POSIX cron must become 6-field AWS EventBridge cron.
 */

import { describe, it, expect } from '@jest/globals'
import {
  convertToCronExpression,
  validateCustomCronExpression,
  type CronScheduleConfig,
} from '@/lib/schedules/cron'

const weekly = (daysOfWeek: number[]): CronScheduleConfig => ({
  frequency: 'weekly',
  time: '08:00',
  daysOfWeek,
})
const custom = (cron: string): CronScheduleConfig => ({
  frequency: 'custom',
  time: '00:00',
  cron,
})

describe('convertToCronExpression — weekly day-of-week (REV-COR-046)', () => {
  it('maps Sunday (UI 0) to AWS 1', () => {
    expect(convertToCronExpression(weekly([0]))).toBe('0 8 ? * 1 *')
  })
  it('maps weekdays (UI 1-5) to AWS 2-6', () => {
    expect(convertToCronExpression(weekly([1, 2, 3, 4, 5]))).toBe('0 8 ? * 2,3,4,5,6 *')
  })
  it('maps Saturday (UI 6) to AWS 7', () => {
    expect(convertToCronExpression(weekly([6]))).toBe('0 8 ? * 7 *')
  })
})

describe('convertToCronExpression — daily/monthly unchanged (regression)', () => {
  it('daily', () => {
    expect(convertToCronExpression({ frequency: 'daily', time: '09:30' })).toBe('30 9 * * ? *')
  })
  it('monthly', () => {
    expect(convertToCronExpression({ frequency: 'monthly', time: '06:15', dayOfMonth: 12 })).toBe(
      '15 6 12 * ? *'
    )
  })
})

describe('convertToCronExpression — custom POSIX → AWS (REV-COR-047)', () => {
  it('daily-ish (both */*) sets day-of-week to ?', () => {
    expect(convertToCronExpression(custom('0 12 * * *'))).toBe('0 12 * * ? *')
  })
  it('POSIX Monday (1) → AWS 2 and day-of-month becomes ?', () => {
    expect(convertToCronExpression(custom('30 8 * * 1'))).toBe('30 8 ? * 2 *')
  })
  it('day-of-month specified → day-of-week becomes ?', () => {
    expect(convertToCronExpression(custom('0 0 1 * *'))).toBe('0 0 1 * ? *')
  })
  it('POSIX day list 0,3 (Sun,Wed) → AWS 1,4', () => {
    expect(convertToCronExpression(custom('15 6 * * 0,3'))).toBe('15 6 ? * 1,4 *')
  })
  it('preserves a step value while shifting the day base (1/2 → 2/2)', () => {
    expect(convertToCronExpression(custom('0 0 * * 1/2'))).toBe('0 0 ? * 2/2 *')
  })
  it('shifts a day-of-week range (1-5 → 2-6)', () => {
    expect(convertToCronExpression(custom('0 0 * * 1-5'))).toBe('0 0 ? * 2-6 *')
  })
  it('throws when both day-of-month and day-of-week are constrained', () => {
    expect(() => convertToCronExpression(custom('0 0 1 * 1'))).toThrow()
  })
})

describe('validateCustomCronExpression (REV-COR-047)', () => {
  it('accepts a valid 5-field POSIX expression', () => {
    expect(validateCustomCronExpression('0 12 * * *')).toEqual([])
    expect(validateCustomCronExpression('30 8 * * 1')).toEqual([])
  })
  it('rejects constraining both day-of-month and day-of-week', () => {
    const errors = validateCustomCronExpression('0 0 1 * 1')
    expect(errors.some(e => /not both/i.test(e))).toBe(true)
  })
  it('rejects the wrong field count', () => {
    expect(validateCustomCronExpression('0 0 * *').some(e => /5 fields/.test(e))).toBe(true)
  })
  it('rejects invalid characters (e.g. the AWS "?")', () => {
    expect(
      validateCustomCronExpression('0 12 ? * *').some(e => /invalid characters/i.test(e))
    ).toBe(true)
  })
  it('rejects day-of-month 0 (no zero value; 1-31 only)', () => {
    expect(
      validateCustomCronExpression('0 0 0 * *').some(e => /invalid day field/i.test(e))
    ).toBe(true)
  })
  it('accepts day-of-month 1 and 31 (boundary values)', () => {
    expect(validateCustomCronExpression('0 0 1 * *')).toEqual([])
    expect(validateCustomCronExpression('0 0 31 * *')).toEqual([])
  })
  it('accepts a day-of-week range combined with a step (e.g. 1-5/2)', () => {
    expect(validateCustomCronExpression('0 0 * * 1-5/2')).toEqual([])
  })
})
