// Kartenwissen (Lanes, Callouts, Granaten-Namen) für 10 Maps. Unbekannte Map: Callout = Lane, Name '<Callout> smoke'.
import type { Nade, NadeType, Side } from '../../model.ts'
import { LANES } from './lanes.ts'
import { WORD, calloutOf, matchNade, normType, placeAt, type LineupCatalog, type Vec3 } from './lineups.ts'
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

const CATALOGS: Record<string, LineupCatalog> = Object.fromEntries(
  [ancient, anubis, cache, dust2, inferno, mirage, nuke, overpass, train, vertigo].map(c => [c.map, c]),
)
const NONE: LineupCatalog = { map: '', callouts: {}, places: [], entries: [] }
const cat = (map: string) => CATALOGS[map] ?? NONE

/** Place → Callout, wie Spieler ihn nennen ("SnipersNest" → "Window"); sonst CamelCase getrennt; '' bleibt '' */
export const calloutName = (map: string, place: string): string => calloutOf(cat(map), place)

/** Place → Laufweg ("LongDoors" → "A long"); unbekannt: Callout */
export const laneOf = (map: string, place: string): string => LANES[map]?.[place] ?? calloutName(map, place)

export const laneSite = (lane: string): 'A' | 'B' | 'Mid' | 'T' | 'CT' =>
  lane === 'T spawn' ? 'T' : lane === 'CT' ? 'CT' : lane[0] === 'A' && lane[1] === ' ' ? 'A' : lane[0] === 'B' && lane[1] === ' ' ? 'B' : 'Mid'

/** Punkt → env_cs_place-Name (Volumen aus dem Katalog); unbekannte Map: '' */
export const placeAtPoint = (map: string, p: Vec3): string => placeAt(cat(map), p)

/** Granate → Lineup-Name ("Window smoke") oder Fallback '<Callout> <Typ>'. place = landPlace aus der Demo, nur für Maps ohne Katalog. */
export function nadeName(map: string, n: { type: NadeType; land: Vec3; throw?: Vec3; side?: Side; place?: string }): { name: string; named: boolean; confidence?: 'high' | 'medium' | 'low' } {
  const h = matchNade(cat(map), n)
  if (h.named) return { name: h.name, named: true, confidence: h.confidence }
  const type = normType(n.type)
  const name = [calloutName(map, h.place || n.place || ''), type ? WORD[type] : n.type].filter(Boolean).join(' ')
  return { name, named: false }
}

/** Eingabe für nadeName aus der Demo-Granate: Landepunkt = letzter Pfadpunkt, Wurf = path[0] */
export function nadeInput(n: Nade, side?: Side): { type: NadeType; land: Vec3; throw?: Vec3; side?: Side; place: string } {
  const a = n.path[0], b = n.path[n.path.length - 1]
  return { type: n.type, land: b ? [b[1], b[2], b[3]] : [0, 0, 0], throw: a && [a[1], a[2], a[3]], side, place: n.landPlace }
}
