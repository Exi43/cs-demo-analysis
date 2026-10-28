// Einstellungen der Lineup-Vorschau, pro PC in localStorage (wie replay3d/options.ts): Fadenkreuz (eigenes, das des Werfers aus der Demo
// oder ein CS2-Code) und „Follow grenade“. Gemalt wird jedes Fadenkreuz mit dem CS2-Zeichner (replay3d/crosshair.ts, CrosshairRender).
import { decodeCrosshair, toRender, type Crosshair, type CrosshairRender } from '../../../shared/crosshair'

export type XhairStyle = 'cross' | 'crossdot' | 'dot' | 'circle'
export type XhairSource = 'custom' | 'thrower' | 'code'
export interface XhairSettings {
  source: XhairSource
  style: XhairStyle
  /** #rrggbb */
  color: string
  /** Pixel bei 1080 Zeilen wie CS2: Armlänge (Kreis: Radius ab Lücke), Dicke (auch Punkt), Lücke */
  size: number; thickness: number; gap: number
  outline: boolean
  /** CS2-Teilen-Code (CS…, CSGO-…) */
  code: string
}
export interface PreviewSettings {
  xhair: XhairSettings
  /** nach dem Wurf der Granate folgen, nach der Landung Außenansicht */
  follow: boolean
}
export const DEFAULT_SETTINGS: PreviewSettings = {
  xhair: { source: 'custom', style: 'crossdot', color: '#44ff44', size: 12, thickness: 3, gap: 5, outline: true, code: '' },
  follow: true,
}
export const XHAIR_RANGE = { size: [2, 30], thickness: [1, 10], gap: [-4, 20] } as const
const STYLES: XhairStyle[] = ['cross', 'crossdot', 'dot', 'circle'], SOURCES: XhairSource[] = ['custom', 'thrower', 'code']
const KEY = 'csda.lineup.preview.v1'

/** gültige Werte aus s über den Standard; Unbekanntes/Falsches → Standard */
export function mergeSettings(s: unknown, base: PreviewSettings = DEFAULT_SETTINGS): PreviewSettings {
  const obj = (v: unknown) => (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const x = obj(obj(s).xhair), d = base.xhair
  const num = (k: keyof typeof XHAIR_RANGE) => { const v = x[k]; return typeof v === 'number' && v >= XHAIR_RANGE[k][0] && v <= XHAIR_RANGE[k][1] ? Math.round(v) : d[k] }
  const one = <T>(v: unknown, list: T[], def: T) => (list.includes(v as T) ? (v as T) : def)
  return {
    xhair: {
      source: one(x.source, SOURCES, d.source), style: one(x.style, STYLES, d.style),
      color: typeof x.color === 'string' && /^#[0-9a-f]{6}$/i.test(x.color) ? x.color.toLowerCase() : d.color,
      size: num('size'), thickness: num('thickness'), gap: num('gap'),
      outline: typeof x.outline === 'boolean' ? x.outline : d.outline, code: typeof x.code === 'string' ? x.code.trim().slice(0, 64) : d.code,
    },
    follow: typeof obj(s).follow === 'boolean' ? (obj(s).follow as boolean) : base.follow,
  }
}
export const loadSettings = () => { try { return mergeSettings(JSON.parse(localStorage.getItem(KEY) ?? 'null')) } catch { return DEFAULT_SETTINGS } }
export const saveSettings = (s: PreviewSettings) => { try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* privater Modus/voll: nur diese Sitzung */ } }

/** CS2-Stil je Form: 4 statisches Kreuz, 6 nur Punkt, 3 statischer Kreis */
const CS2_STYLE: Record<XhairStyle, number> = { cross: 4, crossdot: 4, dot: 6, circle: 3 }
/** Fadenkreuz → CS2-Render-Parameter. thrower = Fadenkreuz des Werfers (Demo); fehlt es bzw. ist der Code ungültig → das eigene */
export function xhairRender(x: XhairSettings, thrower?: Crosshair | null): CrosshairRender {
  const other = x.source === 'thrower' ? thrower : x.source === 'code' ? decodeCrosshair(x.code) : null
  if (other) return toRender(other)
  const rgb = [1, 3, 5].map(i => parseInt(x.color.slice(i, i + 2), 16))
  return {
    style: CS2_STYLE[x.style], gap: x.gap, length: x.size, thickness: x.thickness, dot: x.style === 'crossdot' || x.style === 'dot', tStyle: false,
    color: [rgb[0], rgb[1], rgb[2], 255], outlineMode: x.outline ? 1 : 0, outlineColor: [0, 0, 0, 255], outlineThickness: 1, screenHeight: 1080,
    dynamicSpreadLimit: 0, splitDistance: 0, innerSplitAlpha: 1, outerSplitAlpha: 1, splitSizeRatio: 1,
  }
}
