// Highlight-Liste (highlights.ts) synthetisch: Sortierung, Startpunkt 5 s davor (nicht vor Rundenstart), Filter Spieler/Kills/Tode,
// Ego-Sicht Killer/Opfer, jedes Ereignis bei "alle" nur einmal, Weiterschalten von "Play all".
import { describe, expect, it } from 'vitest'
import type { Kill, MatchData } from '../../shared/model'
import { highlights, reelStep } from './highlights'

const R = 64
const kill = (tick: number, attacker: string | undefined, victim: string, x: Partial<Kill> = {}) =>
  ({ tick, attacker, victim, weapon: 'AK-47', headshot: false, ...x }) as Kill
const tracks = [{ steamid: 'a', side: 'CT' }, { steamid: 'b', side: 'T' }, { steamid: 'c', side: 'T' }]
const match = {
  tickrate: R,
  rounds: [
    // Runde 1: Kills absichtlich unsortiert; c stirbt 2 s nach Rundenstart (Startpunkt wird gekappt)
    { num: 1, startTick: 1000, freezeEndTick: 1000 + 20 * R, endTick: 9000, tracks,
      kills: [kill(5000, 'a', 'b', { headshot: true }), kill(1000 + 2 * R, 'b', 'c'), kill(4000, 'b', 'a', { weapon: 'AWP' })] },
    // Runde 2: Selbstmord von b, Welt-Tod von a
    { num: 2, startTick: 10000, freezeEndTick: 10000 + 20 * R, endTick: 20000, tracks,
      kills: [kill(12000, 'b', 'b'), kill(13000, undefined, 'a')] },
  ],
} as unknown as MatchData

describe('highlights', () => {
  it('sortiert nach Tick über alle Runden, Start 5 s davor, nicht vor Rundenstart, Ende 2 s danach', () => {
    const l = highlights(match, null, 'both')
    expect(l.map(h => h.tick)).toEqual([1000 + 2 * R, 4000, 5000, 12000, 13000])
    expect(l.map(h => h.start)).toEqual([1000, 4000 - 5 * R, 5000 - 5 * R, 12000 - 5 * R, 13000 - 5 * R])
    expect(l[1].end).toBe(4000 + 2 * R)
    expect(l.map(h => h.round)).toEqual([1, 1, 1, 2, 2])
  })

  it('alle Spieler: jedes Ereignis einmal, Kill aus Sicht des Killers, Selbstmord/Welt als Tod des Opfers', () => {
    const l = highlights(match, null, 'both')
    expect(l.map(h => `${h.kind}:${h.pov}`)).toEqual(['kill:b', 'kill:b', 'kill:a', 'death:b', 'death:a'])
    expect(highlights(match, null, 'kill').map(h => h.tick)).toEqual([1000 + 2 * R, 4000, 5000])
    expect(highlights(match, null, 'death').map(h => `${h.kind}:${h.pov}`)).toEqual(['death:c', 'death:a', 'death:b', 'death:b', 'death:a'])
  })

  it('ein Spieler: Kills (Ego Killer), Tode (Ego Opfer), beides; Seiten, Waffe, Kopfschuss, Rundenuhr', () => {
    expect(highlights(match, 'b', 'kill').map(h => h.tick)).toEqual([1000 + 2 * R, 4000])
    expect(highlights(match, 'b', 'death').map(h => h.tick)).toEqual([5000, 12000])
    const both = highlights(match, 'b', 'both')
    expect(both.map(h => `${h.kind}@${h.tick}`)).toEqual([`kill@${1000 + 2 * R}`, 'kill@4000', 'death@5000', 'death@12000'])
    expect(both.every(h => h.pov === 'b')).toBe(true)
    const hs = both[2]
    expect(hs).toMatchObject({ attacker: 'a', attackerSide: 'CT', victim: 'b', victimSide: 'T', weapon: 'AK-47', headshot: true })
    expect(hs.clock).toBeCloseTo(115 - (5000 - 1000 - 20 * R) / R)
    expect(highlights(match, 'a', 'death').map(h => h.attacker)).toEqual(['b', undefined])
  })

  it('Play all: weiter nach dem Ende, fertig nach dem letzten, Abbruch bei Sprung aus dem Fenster', () => {
    const l = highlights(match, 'b', 'kill') // [2 s nach Rundenstart, 4000]
    expect(reelStep(l, 0, l[0].start, R)).toBe('play')
    expect(reelStep(l, 0, l[0].end - 1, R)).toBe('play')
    expect(reelStep(l, 0, l[0].end, R)).toBe('next')
    expect(reelStep(l, 1, l[1].end + 10, R)).toBe('done')
    expect(reelStep(l, 1, l[1].start - 2 * R, R)).toBe('cancel')
    expect(reelStep(l, 1, l[1].end + 15 * R, R)).toBe('cancel')
  })
})
