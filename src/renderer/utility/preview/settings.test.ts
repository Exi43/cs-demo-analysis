// Einstellungen der Lineup-Vorschau (settings.ts): Prüfung gespeicherter Werte, Fadenkreuz → CS2-Render-Parameter (eigenes, Werfer, Code).
import { describe, expect, it } from 'vitest'
import { decodeCrosshair } from '../../../shared/crosshair'
import { DEFAULT_SETTINGS, mergeSettings, xhairRender, type XhairSettings } from './settings'

const X = DEFAULT_SETTINGS.xhair
describe('mergeSettings', () => {
  it('übernimmt gültige Werte, falsche und fehlende → Standard bzw. base', () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(mergeSettings({ xhair: { style: 'circle', color: '#FFEE00', size: 9.6, thickness: 99, gap: 'x', source: 'code', code: '  CSabc  ' }, follow: false })).toEqual({
      xhair: { ...X, style: 'circle', color: '#ffee00', size: 10, source: 'code', code: 'CSabc' }, follow: false,
    })
    expect(mergeSettings({ xhair: { style: 'star', color: 'red', outline: 1 } }).xhair).toEqual(X)
    const base = { ...DEFAULT_SETTINGS, xhair: { ...X, size: 20 }, follow: false }
    expect(mergeSettings({ xhair: { gap: 2 } }, base)).toEqual({ xhair: { ...X, size: 20, gap: 2 }, follow: false })
  })
})

describe('xhairRender', () => {
  const own = (p: Partial<XhairSettings>) => xhairRender({ ...X, ...p })
  it('eigenes: Form → CS2-Stil, Farbe, Maße in Pixeln bei 1080, Umriss schwarz', () => {
    expect(own({})).toMatchObject({ style: 4, dot: true, color: [0x44, 0xff, 0x44, 255], length: 12, thickness: 3, gap: 5, outlineMode: 1, outlineColor: [0, 0, 0, 255], screenHeight: 1080 })
    expect(own({ style: 'cross', outline: false })).toMatchObject({ style: 4, dot: false, outlineMode: 0 })
    expect(own({ style: 'circle', color: '#00e5ff' })).toMatchObject({ style: 3, dot: false, color: [0, 0xe5, 0xff, 255] })
    expect(own({ style: 'dot' })).toMatchObject({ style: 6, dot: true })
  })
  it('Werfer bzw. Code aus der Demo/CS2, fehlt oder ungültig → eigenes', () => {
    const code = 'CSGO-G8oAC-RyvWc-Hi3CZ-voSwn-QJbfE', c = decodeCrosshair(code)!
    expect(xhairRender({ ...X, source: 'thrower' }, c)).toMatchObject({ style: 8, gap: 25, length: 7, thickness: 20, screenHeight: 768 })
    expect(xhairRender({ ...X, source: 'thrower' }, null)).toMatchObject({ style: 4, screenHeight: 1080 })
    expect(xhairRender({ ...X, source: 'code', code })).toMatchObject({ style: 8, screenHeight: 768 })
    expect(xhairRender({ ...X, source: 'code', code: 'CSGO-12345-12345-12345-12345-1234' })).toMatchObject({ style: 4, screenHeight: 1080 })
  })
})
