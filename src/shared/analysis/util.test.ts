import { describe, expect, it } from 'vitest'
import { clock, countBy, median, pct, tagOf } from './util.ts'

describe('util', () => {
  it('tagOf', () => {
    expect(tagOf(3, 9)).toEqual({ kind: 'HABIT', n: 3, N: 9 })
    expect(tagOf(2, 4).kind).toBe('PATTERN')
    expect(tagOf(1, 12).kind).toBe('ONCE')
  })
  it('clock', () => {
    expect(clock(0)).toBe('1:55')
    expect(clock(32)).toBe('1:23')
    expect(clock(64.9)).toBe('0:50')
    expect(clock(200)).toBe('0:00')
  })
  it('countBy, median, pct', () => {
    expect(countBy(['a', 'b', 'a', undefined, ''], x => x)).toEqual([['a', 2], ['b', 1]])
    expect(median([])).toBeUndefined()
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(pct(5, 82)).toBe(6)
    expect(pct(1, 0)).toBe(0)
  })
})
