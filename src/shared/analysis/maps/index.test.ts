import { describe, expect, it } from 'vitest'
import { calloutName, laneOf, laneSite, nadeName, placeAtPoint } from './index.ts'
import { LANES } from './lanes.ts'
import ancient from './catalog/de_ancient.ts'
import anubis from './catalog/de_anubis.ts'
import cache from './catalog/de_cache.ts'
import dust2 from './catalog/de_dust2.ts'
import inferno from './catalog/de_inferno.ts'
import mirage from './catalog/de_mirage.ts'
import nuke from './catalog/de_nuke.ts'
import overpass from './catalog/de_overpass.ts'
import train from './catalog/de_train.ts'
import vertigo from './catalog/de_vertigo.ts'

describe('maps', () => {
  it('Mirage Window smoke', () => {
    expect(nadeName('de_mirage', { type: 'smoke', land: [-1172, -636, -166], throw: [1286, 137, -100], side: 'T' })).toMatchObject({ name: 'Window smoke', named: true })
    expect(calloutName('de_mirage', 'SnipersNest')).toBe('Window')
    expect(laneOf('de_mirage', 'SnipersNest')).toBe('Mid')
  })
  it('Dust2 XBox', () => {
    expect(nadeName('de_dust2', { type: 'smoke', land: [-294, 1435, -25], side: 'T' })).toMatchObject({ name: 'XBox smoke', named: true })
    expect(placeAtPoint('de_dust2', [-294, 1435, -25])).toBe('Middle')
  })
  it('Inferno CT smoke', () => {
    expect(nadeName('de_inferno', { type: 'smoke', land: [959, 2699, 135], side: 'T' }).name).toBe('CT smoke')
    expect(laneSite(laneOf('de_inferno', 'Banana'))).toBe('B')
  })
  it('Ancient Cave', () => {
    expect(nadeName('de_ancient', { type: 'smoke', land: [569, 158, 145], side: 'T' }).name).toBe('Cave smoke')
    expect(laneOf('de_ancient', 'SideEntrance')).toBe('B cave')
    expect(laneSite('B cave')).toBe('B')
  })
  it('Anubis Canal = Water', () => {
    expect(placeAtPoint('de_anubis', [-430, 88, -117])).toBe('Canal')
    expect(calloutName('de_anubis', 'Canal')).toBe('Water')
    expect(nadeName('de_anubis', { type: 'molotov', land: [-430, 88, -117] }).name).toBe('Water molly')
  })
  it('unknown map: callout = lane, never empty', () => {
    expect(laneOf('de_foo', 'TopofMid')).toBe('Top of Mid')
    expect(laneSite(laneOf('de_foo', 'TSpawn'))).toBe('Mid')
    expect(nadeName('de_foo', { type: 'smoke', land: [0, 0, 0], place: 'TopofMid' })).toEqual({ name: 'Top of Mid smoke', named: false })
    expect(nadeName('de_foo', { type: 'decoy', land: [0, 0, 0] }).name).toBe('decoy')
  })
  it('every place of the 10 maps has a lane', () => {
    for (const c of [ancient, anubis, cache, dust2, inferno, mirage, nuke, overpass, train, vertigo]) {
      expect(c.places.map(p => p.name).filter(p => !LANES[c.map]?.[p]), c.map).toEqual([])
    }
  })
})
