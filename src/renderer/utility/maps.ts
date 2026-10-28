// Utility-Dashboard: Maps (Pool Okt. 2026 + alle anderen Radare aus resources/maps), Radar ↔ Welt, Callout-Vorschlag für Titel
import type { NadeType } from '../../shared/utility'
import type { RadarMeta } from '../../shared/utility-api'
import { calloutName, placeAtPoint } from '../../shared/analysis/maps'
import { weaponIcon } from '../weapons'

/** aktueller Active-Duty-Pool (Okt. 2026) */
export const POOL = ['de_ancient', 'de_anubis', 'de_cache', 'de_dust2', 'de_inferno', 'de_mirage', 'de_nuke']
/** Kachelfarbe je Map (eigene Palette nach Stimmung der Map); die Radare selbst sind teils dunkel, teils hell */
const COLORS: Record<string, string> = {
  de_ancient: '#2f7a55', de_anubis: '#b8893f', de_cache: '#6f8a3c', de_dust2: '#c9873a', de_inferno: '#b0463a', de_mirage: '#bf7444',
  de_nuke: '#3a7bb8', de_overpass: '#4f8a78', de_train: '#7a6f5a', de_vertigo: '#5a74a8', cs_office: '#6d7488', cs_italy: '#a8653f',
}
export const mapColor = (m: string) => COLORS[m.replace(/_night$/, '')] ?? '#596070'
export const mapName = (m: string) => m.replace(/^(de|cs|ar)_/, '').split('_').map(s => s[0].toUpperCase() + s.slice(1)).join(' ')
export const radarUrl = (m: string, lower = false) => `csutil://radar/${m}${lower ? '_lower' : ''}.png`
export const imageUrl = (hash: string) => `csutil://img/${hash}.webp`

/** Welt → Radar-Pixel (Radarbilder sind 1024²) und zurück */
export const toRadar = (m: RadarMeta, p: { x: number; y: number }) => ({ x: (p.x - m.pos_x) / m.scale, y: (m.pos_y - p.y) / m.scale })
export const fromRadar = (m: RadarMeta, px: number, py: number) => ({ x: Math.round(px * m.scale + m.pos_x), y: Math.round(m.pos_y - py * m.scale) })
/** Höhe unter AltitudeMax der unteren Ebene (Nuke, Train, Vertigo …) = unteres Radar */
export const lowerMax = (m?: RadarMeta) => { const v = m?.verticalsections?.lower?.AltitudeMax; return v == null ? undefined : Number(v) }
export const isLower = (m: RadarMeta | undefined, z?: number) => { const lm = lowerMax(m); return z != null && lm != null && z < lm }

export const TYPES: { id: NadeType; label: string; plural: string; icon: string }[] = [
  { id: 'smoke', label: 'Smoke', plural: 'Smokes', icon: 'smokegrenade' },
  { id: 'flash', label: 'Flash', plural: 'Flashbangs', icon: 'flashbang' },
  { id: 'molotov', label: 'Molotov', plural: 'Molotovs', icon: 'molotov' },
  { id: 'he', label: 'HE', plural: 'HE grenades', icon: 'hegrenade' },
  { id: 'decoy', label: 'Decoy', plural: 'Decoys', icon: 'decoy' },
]
export const typeOf = (t: NadeType) => TYPES.find(x => x.id === t)!
export const typeIcon = (t: NadeType) => weaponIcon(typeOf(t).icon)

/** Titelvorschlag aus den Callouts der Kartenkataloge: „Xbox smoke from T spawn“; ohne Katalog nur der Typ */
export function suggestTitle(map: string, type: NadeType, stand?: { x: number; y: number; z?: number }, target?: { x: number; y: number; z?: number }) {
  const at = (p?: { x: number; y: number; z?: number }) => (p ? calloutName(map, placeAtPoint(map, [p.x, p.y, p.z ?? 0])) : '')
  const to = at(target), from = at(stand), word = typeOf(type).label.toLowerCase()
  return [to ? `${to} ${word === 'he' ? 'HE' : word}` : typeOf(type).label, from && from !== to ? `from ${from}` : ''].filter(Boolean).join(' ')
}
