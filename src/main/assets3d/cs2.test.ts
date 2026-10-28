// Tempo des Asset-Baus: Grenze der Semaphore, Teile nacheinander (Hintergrund) bzw. gleichzeitig nach boost (Vordergrund)
import { describe, expect, it } from 'vitest'
import { boost, lanes, limiter } from './cs2.ts'

const tick = () => new Promise(r => setTimeout(r, 5))

describe('limiter', () => {
  it('hält die Grenze und lässt nach set() mehr zu', async () => {
    const lim = limiter(1)
    let now = 0, peak = 0
    const job = () => lim.run(async () => { peak = Math.max(peak, ++now); await tick(); now-- })
    await Promise.all([job(), job(), job()])
    expect(peak).toBe(1)
    peak = 0
    const all = Promise.all([job(), job(), job()])
    lim.set(3)
    await all
    expect(peak).toBe(3)
  })
})

describe('lane', () => {
  it('nacheinander bis boost, danach sofort; Fehler stoppt spätere Teile', async () => {
    const log: string[] = [], lane = lanes()
    const part = (n: string) => lane(async () => { log.push(`${n}+`); await tick(); log.push(`${n}-`) })
    await Promise.all([part('a'), part('b')])
    expect(log).toEqual(['a+', 'a-', 'b+', 'b-'])
    log.length = 0
    boost()
    await Promise.all([part('c'), part('d')])
    expect(log.slice(0, 2)).toEqual(['c+', 'd+'])
    const bad = lane(async () => { throw new Error('x') })
    await expect(bad).rejects.toThrow('x')
    await expect(lane(async () => 1)).rejects.toThrow(/stopped/)
  })
})
