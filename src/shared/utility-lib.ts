// Utility-Bibliothek ohne UI (Main, Fenster, Tests): eingebaute Wurftechniken, Prüfung fremder Daten (Import-Datei, Speichern),
// Teilmenge für den Export und der Abgleich beim Import (neu / doppelt / Konflikt). Später auch Grundlage für den Team-Sync.
import type { Lineup, NadeType, Playbook, Tag, UtilityLibrary } from './utility.ts'

export const NADE_TYPES: readonly NadeType[] = ['smoke', 'flash', 'molotov', 'he', 'decoy']
export const BUILTIN_TECHNIQUES: readonly { id: string; label: string }[] = [
  { id: 'stand', label: 'Stand' }, { id: 'walk', label: 'Walk' }, { id: 'run', label: 'Run' }, { id: 'crouch', label: 'Crouch' },
  { id: 'jump', label: 'Jump' }, { id: 'jumpthrow', label: 'Jumpthrow' }, { id: 'wjumpthrow', label: 'W + Jumpthrow' },
  { id: 'left', label: 'Left click' }, { id: 'right', label: 'Right click' }, { id: 'both', label: 'Left + right click' },
]
/** Bilder je Lineup */
export const MAX_IMAGES = 6
/** gleiche Stand-/Zielposition für den Abgleich (Weltunits; ein Radar-Pixel sind ~4–7) */
export const SAME_POS = 32
export const EXPORT_FORMAT = 'csda-utility'
/** Export-/Importdatei: Bibliothek (Teilmenge) + Bilder (sha1 → WebP base64) + lokale Videos nur auf Wunsch */
export interface UtilityExport {
  format: typeof EXPORT_FORMAT
  version: 1
  exportedAt: number
  library: UtilityLibrary
  images: Record<string, string>
  videos?: Record<string, string>
}

export const emptyLibrary = (): UtilityLibrary => ({ version: 1, lineups: [], tags: [], playbooks: [], techniques: [] })
export const isWebUrl = (s: string) => { try { return /^https?:$/.test(new URL(s).protocol) } catch { return false } }
export const HASH_RE = /^[0-9a-f]{40}$/
export const VIDEO_RE = /^[0-9a-f]{40}\.(mp4|webm)$/

// ---------------------------------------------------------------- Prüfung (fremde Eingabe → saubere Objekte, unbekannte Felder fallen weg)

type V<T> = (v: unknown, at: string) => T
const fail = (at: string, what: string): never => { throw new Error(`${at}: ${what}`) }
const obj = (v: unknown, at: string) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : fail(at, 'expected an object'))
const str = (max: number, re?: RegExp): V<string> => (v, at) =>
  typeof v === 'string' && v.length <= max && (!re || re.test(v)) ? v : fail(at, re ? 'invalid value' : `expected text up to ${max} characters`)
const num = (min: number, max: number): V<number> => (v, at) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fail(at, `expected a number from ${min} to ${max}`)
const bool: V<boolean> = (v, at) => (typeof v === 'boolean' ? v : fail(at, 'expected true or false'))
const oneOf = <T extends string>(list: readonly T[]): V<T> => (v, at) => (list.includes(v as T) ? (v as T) : fail(at, `expected ${list.join(' / ')}`))
const opt = <T>(f: V<T>): V<T | undefined> => (v, at) => (v == null ? undefined : f(v, at))
const arr = <T>(item: V<T>, max: number): V<T[]> => (v, at) =>
  Array.isArray(v) && v.length <= max ? v.map((x, i) => item(x, `${at}[${i}]`)) : fail(at, `expected a list of up to ${max} entries`)
const record = <T>(key: V<string>, val: V<T>, max: number): V<Record<string, T>> => (v, at) => {
  const e = Object.entries(obj(v, at))
  if (e.length > max) fail(at, `more than ${max} entries`)
  return Object.fromEntries(e.map(([k, x]) => [key(k, `${at} name`), val(x, `${at}.${k}`)]))
}
function shape<T>(spec: { [K in keyof T]-?: V<T[K]> }): V<T> {
  return (v, at) => {
    const o = obj(v, at), out: Record<string, unknown> = {}
    for (const k in spec) { const r = spec[k](o[k], `${at}.${k}`); if (r !== undefined) out[k] = r }
    return out as T
  }
}
const unique = <T extends { id: string }>(list: T[], at: string) => {
  const seen = new Set<string>()
  for (const x of list) { if (seen.has(x.id)) fail(at, `duplicate id ${x.id}`); seen.add(x.id) }
  return list
}

const ID = /^[A-Za-z0-9_-]{1,64}$/
const id = str(64, ID)
const mapName = str(64, /^[a-z0-9_]+$/)
const url: V<string> = (v, at) => (isWebUrl(str(2000)(v, at)) ? (v as string) : fail(at, 'expected an http or https link'))
const coord = num(-65536, 65536)
const time = num(0, 1e14)
const point = shape<Lineup['stand']>({ x: coord, y: coord, z: opt(coord) })
const lineup = shape<Lineup>({
  id, map: mapName, type: oneOf(NADE_TYPES), side: oneOf(['T', 'CT', 'both'] as const), title: str(200), description: opt(str(200)),
  stand: point, target: point, aim: opt(shape<NonNullable<Lineup['aim']>>({ pitch: num(-90, 90), yaw: num(-360, 360) })),
  technique: arr(id, 20), steps: arr(str(2000), 50), images: arr(str(40, HASH_RE), MAX_IMAGES),
  video: opt(shape<NonNullable<Lineup['video']>>({ url: opt(url), local: opt(str(60, VIDEO_RE)) })), sourceUrl: opt(url),
  tags: arr(id, 50), fields: opt(record(str(100), str(2000), 50)), favorite: opt(bool),
  demo: opt(shape<NonNullable<Lineup['demo']>>({ matchId: str(64), tick: num(0, 1e9), steamid: str(32), player: opt(str(100)), round: opt(num(0, 1000)) })),
  author: opt(str(100)),
  owner: (v, at) => (v === 'local' ? 'local' : shape<{ team: string }>({ team: str(64) })(v, at)),
  createdAt: time, updatedAt: time, deleted: opt(bool),
})
const tag = shape<Tag>({ id, name: str(60), color: str(7, /^#[0-9a-fA-F]{6}$/), updatedAt: time, deleted: opt(bool) })
const playbook = shape<Playbook>({ id, name: str(120), map: opt(mapName), lineupIds: arr(id, 500), notes: opt(str(5000)), updatedAt: time, deleted: opt(bool) })
const technique = shape<{ id: string; label: string }>({ id, label: str(40) })

/** Bibliothek prüfen (library.json, Speichern aus dem Fenster, Import); wirft Error mit Pfad, z. B. „library.lineups[3].title: …“ */
export function parseLibrary(v: unknown, at = 'library'): UtilityLibrary {
  const o = obj(v, at)
  if (o.version !== 1) fail(`${at}.version`, 'unsupported version')
  return {
    version: 1,
    lineups: unique(arr(lineup, 20000)(o.lineups, `${at}.lineups`), `${at}.lineups`),
    tags: unique(arr(tag, 1000)(o.tags, `${at}.tags`), `${at}.tags`),
    playbooks: unique(arr(playbook, 1000)(o.playbooks, `${at}.playbooks`), `${at}.playbooks`),
    techniques: unique(arr(technique, 100)(o.techniques ?? [], `${at}.techniques`), `${at}.techniques`),
  }
}

/** Import-Datei prüfen; Bild-/Videodaten bleiben base64 (Main dekodiert und prüft sha1 + Format) */
export function parseExport(v: unknown, maxImageB64: number, maxVideoB64: number): { library: UtilityLibrary; images: Record<string, string>; videos: Record<string, string> } {
  const o = obj(v, 'file')
  if (o.format !== EXPORT_FORMAT) fail('file', 'not a CS Demo Analysis utility file')
  if (o.version !== 1) fail('file.version', 'unsupported version')
  const b64 = (max: number) => str(max, /^[A-Za-z0-9+/]*={0,2}$/)
  return {
    library: parseLibrary(o.library),
    images: record(str(40, HASH_RE), b64(maxImageB64), 50000)(o.images ?? {}, 'images'),
    videos: record(str(60, VIDEO_RE), b64(maxVideoB64), 1000)(o.videos ?? {}, 'videos'),
  }
}

// ---------------------------------------------------------------- Export: Teilmenge

/**
 * Teilmenge für den Export: gewählte Lineups (ohne gelöschte), ihre Tags und eigenen Techniken, Playbooks nur ganz enthalten
 * (Verweise auf gelöschte Lineups fallen weg). Ohne Videos: lokale Videos raus (die Datei fehlt beim Empfänger).
 */
export function subsetLibrary(lib: UtilityLibrary, lineupIds: Iterable<string>, withVideos: boolean): UtilityLibrary {
  const want = new Set(lineupIds), live = new Set(lib.lineups.filter(l => !l.deleted).map(l => l.id))
  const lineups = lib.lineups.filter(l => !l.deleted && want.has(l.id)).map(l => {
    if (withVideos || !l.video?.local) return l
    const { local: _, ...video } = l.video
    return { ...l, video: video.url ? video : undefined }
  })
  const ids = new Set(lineups.map(l => l.id)), tagIds = new Set(lineups.flatMap(l => l.tags)), tech = new Set(lineups.flatMap(l => l.technique))
  const playbooks = lib.playbooks.filter(p => !p.deleted).map(p => ({ ...p, lineupIds: p.lineupIds.filter(i => live.has(i)) }))
    .filter(p => p.lineupIds.length > 0 && p.lineupIds.every(i => ids.has(i)))
  return {
    version: 1, lineups, playbooks,
    tags: lib.tags.filter(t => !t.deleted && tagIds.has(t.id)),
    techniques: lib.techniques.filter(t => tech.has(t.id)),
  }
}

// ---------------------------------------------------------------- Abgleich beim Import

export type ImportKind = 'lineup' | 'tag' | 'playbook'
export type ImportStatus = 'new' | 'duplicate' | 'conflict'
/** add = neu übernehmen, skip = lokal lassen, replace = lokales überschreiben, both = beide behalten (Import bekommt neue ID) */
export type ImportChoice = 'add' | 'skip' | 'replace' | 'both'
export interface ImportItem {
  kind: ImportKind
  /** ID in der Datei */
  id: string
  name: string
  status: ImportStatus
  /** englischer Grund bei doppelt/Konflikt */
  reason?: string
  /** lokales Gegenstück */
  localId?: string
  choice: ImportChoice
}

/** erlaubte Entscheidungen je Status; die erste ist die Vorgabe */
export function choicesFor(it: Pick<ImportItem, 'kind' | 'status'>): ImportChoice[] {
  if (it.status === 'new') return ['add', 'skip']
  if (it.status === 'duplicate') return it.kind === 'lineup' ? ['skip', 'both'] : ['skip']
  return ['skip', 'replace', 'both']
}

const norm = (s: string) => s.trim().toLowerCase()
const near = (a: Lineup['stand'], b: Lineup['stand']) => Math.hypot(a.x - b.x, a.y - b.y) < SAME_POS && (a.z == null || b.z == null || Math.abs(a.z - b.z) < SAME_POS * 2)
const rp = (p: Lineup['stand']) => [Math.round(p.x), Math.round(p.y), p.z == null ? null : Math.round(p.z)]
const tagNames = (lib: UtilityLibrary) => {
  const m = new Map(lib.tags.filter(t => !t.deleted).map(t => [t.id, norm(t.name)]))
  return (ids: string[]) => ids.map(i => m.get(i)).filter((n): n is string => !!n).sort()
}
/** Inhalt eines Lineups ohne ID, Zeiten, Besitzer und Favorit; Tags über ihren Namen (IDs unterscheiden sich zwischen Bibliotheken) */
function lineupKey(l: Lineup, names: (ids: string[]) => string[]) {
  return JSON.stringify([l.map, l.type, l.side, l.title.trim(), l.description?.trim() ?? '', rp(l.stand), rp(l.target), l.aim ? [Math.round(l.aim.pitch * 10), Math.round(l.aim.yaw * 10)] : null,
    [...l.technique].sort(), l.steps, l.images, l.video?.url ?? '', l.video?.local ?? '', l.sourceUrl ?? '', names(l.tags),
    Object.entries(l.fields ?? {}).sort(), l.demo ? [l.demo.matchId, l.demo.tick, l.demo.steamid] : null, l.author ?? ''])
}

/** Vorschau: jeder (nicht gelöschte) Eintrag der Datei mit Status und Vorgabe; gelöschte lokale Einträge zählen als nicht vorhanden */
export function planImport(local: UtilityLibrary, incoming: UtilityLibrary): ImportItem[] {
  const items: ImportItem[] = []
  const item = (kind: ImportKind, id: string, name: string, status: ImportStatus, localId?: string, reason?: string) =>
    items.push({ kind, id, name, status, localId, reason, choice: choicesFor({ kind, status })[0] })

  const tags = local.tags.filter(t => !t.deleted)
  for (const t of incoming.tags.filter(t => !t.deleted)) {
    const byId = tags.find(x => x.id === t.id), byName = tags.find(x => norm(x.name) === norm(t.name))
    const m = byId ?? byName
    if (!m) item('tag', t.id, t.name, 'new')
    else if (norm(m.name) === norm(t.name) && m.color.toLowerCase() === t.color.toLowerCase()) item('tag', t.id, t.name, 'duplicate', m.id, 'Same tag')
    else if (norm(m.name) !== norm(t.name)) item('tag', t.id, t.name, 'conflict', m.id, `Same ID, local name "${m.name}"`)
    else item('tag', t.id, t.name, 'conflict', m.id, 'Same name, different color')
  }

  const live = local.lineups.filter(l => !l.deleted), lk = tagNames(local), ik = tagNames(incoming)
  const keys = new Map(live.map(l => [lineupKey(l, lk), l.id]))
  const dup = new Map<string, string>() // Import-ID → lokale ID (für den Playbook-Vergleich)
  for (const l of incoming.lineups.filter(l => !l.deleted)) {
    const key = lineupKey(l, ik), byId = live.find(x => x.id === l.id)
    if (byId) {
      const same = lineupKey(byId, lk) === key
      item('lineup', l.id, l.title, same ? 'duplicate' : 'conflict', byId.id, same ? 'Same lineup' : 'Same ID, different content')
      dup.set(l.id, byId.id)
      continue
    }
    const twin = keys.get(key)
    if (twin) { item('lineup', l.id, l.title, 'duplicate', twin, 'Same lineup'); dup.set(l.id, twin); continue }
    const pos = live.find(x => x.map === l.map && x.type === l.type && near(x.stand, l.stand) && near(x.target, l.target))
    if (pos) item('lineup', l.id, l.title, 'conflict', pos.id, 'Same position, target and type')
    else item('lineup', l.id, l.title, 'new')
  }

  const pbs = local.playbooks.filter(p => !p.deleted)
  const pbKey = (p: Playbook, ids: string[]) => JSON.stringify([norm(p.name), p.map ?? '', (p.notes ?? '').trim(), ids])
  for (const p of incoming.playbooks.filter(p => !p.deleted)) {
    const m = pbs.find(x => x.id === p.id) ?? pbs.find(x => norm(x.name) === norm(p.name) && (x.map ?? '') === (p.map ?? ''))
    if (!m) item('playbook', p.id, p.name, 'new')
    else if (pbKey(m, m.lineupIds) === pbKey(p, p.lineupIds.map(i => dup.get(i) ?? i))) item('playbook', p.id, p.name, 'duplicate', m.id, 'Same playbook')
    else item('playbook', p.id, p.name, 'conflict', m.id, m.id === p.id ? 'Same ID, different content' : 'Same name, different content')
  }
  return items
}

/** Entscheidung für alle Einträge eines Status setzen („für alle“), nur wo erlaubt */
export const chooseAll = (items: ImportItem[], status: ImportStatus, choice: ImportChoice) =>
  items.map(it => (it.status === status && choicesFor(it).includes(choice) ? { ...it, choice } : it))

/**
 * Entscheidungen anwenden → neue Bibliothek (lokale bleibt unverändert). Tag-/Lineup-IDs werden umgeschrieben, wo der Import
 * auf ein lokales Gegenstück zeigt oder eine neue ID bekommt; übersprungene neue Lineups fallen aus importierten Playbooks.
 */
export function applyImport(local: UtilityLibrary, incoming: UtilityLibrary, items: ImportItem[], now = Date.now(), newId: () => string = () => crypto.randomUUID()): UtilityLibrary {
  const lib: UtilityLibrary = { ...local, lineups: [...local.lineups], tags: [...local.tags], playbooks: [...local.playbooks], techniques: [...local.techniques] }
  const pick = (kind: ImportKind, id: string) => items.find(i => i.kind === kind && i.id === id)
  /** gleiche ID lokal (auch gelöscht) ersetzen, sonst anhängen */
  const put = <T extends { id: string }>(list: T[], x: T) => { const i = list.findIndex(y => y.id === x.id); if (i >= 0) list[i] = x; else list.push(x) }
  const imported = (name: string, list: { name: string; deleted?: boolean }[]) => (list.some(x => !x.deleted && norm(x.name) === norm(name)) ? `${name} (imported)` : name)

  const tagMap = new Map<string, string>()
  for (const t of incoming.tags) {
    const it = pick('tag', t.id)
    if (!it || it.choice === 'skip') { if (it?.localId) tagMap.set(t.id, it.localId); continue }
    if (it.choice === 'add') { put(lib.tags, { ...t, updatedAt: now }); tagMap.set(t.id, t.id) }
    if (it.choice === 'replace' && it.localId) {
      const i = lib.tags.findIndex(x => x.id === it.localId)
      lib.tags[i] = { ...lib.tags[i], name: t.name, color: t.color, updatedAt: now }
      tagMap.set(t.id, it.localId)
    }
    if (it.choice === 'both') { const nt = { ...t, id: newId(), name: imported(t.name, lib.tags), updatedAt: now }; lib.tags.push(nt); tagMap.set(t.id, nt.id) }
  }

  const lineMap = new Map<string, string>()
  const fix = (l: Lineup): Lineup => ({ ...l, tags: [...new Set(l.tags.map(t => tagMap.get(t)).filter((t): t is string => !!t))], owner: 'local' })
  for (const l of incoming.lineups) {
    const it = pick('lineup', l.id)
    if (!it || it.choice === 'skip') { if (it?.localId) lineMap.set(l.id, it.localId); continue }
    if (it.choice === 'add') { put(lib.lineups, { ...fix(l), updatedAt: now }); lineMap.set(l.id, l.id) }
    if (it.choice === 'replace' && it.localId) {
      const i = lib.lineups.findIndex(x => x.id === it.localId), old = lib.lineups[i]
      lib.lineups[i] = { ...fix(l), id: old.id, createdAt: old.createdAt, favorite: old.favorite, updatedAt: now }
      lineMap.set(l.id, old.id)
    }
    if (it.choice === 'both') { const nl = { ...fix(l), id: newId(), createdAt: now, updatedAt: now }; lib.lineups.push(nl); lineMap.set(l.id, nl.id) }
  }

  for (const p of incoming.playbooks) {
    const it = pick('playbook', p.id)
    if (!it || it.choice === 'skip') continue
    const lineupIds = p.lineupIds.map(i => lineMap.get(i)).filter((i): i is string => !!i)
    if (it.choice === 'add') put(lib.playbooks, { ...p, lineupIds, updatedAt: now })
    if (it.choice === 'replace' && it.localId) {
      const i = lib.playbooks.findIndex(x => x.id === it.localId)
      lib.playbooks[i] = { ...lib.playbooks[i], name: p.name, map: p.map, notes: p.notes, lineupIds, updatedAt: now }
    }
    if (it.choice === 'both') lib.playbooks.push({ ...p, id: newId(), name: imported(p.name, lib.playbooks), lineupIds, updatedAt: now })
  }

  // eigene Wurftechniken: fehlende IDs übernehmen (gleiche ID = gleiche Technik)
  for (const t of incoming.techniques) if (!lib.techniques.some(x => x.id === t.id) && !BUILTIN_TECHNIQUES.some(x => x.id === t.id)) lib.techniques.push(t)
  return lib
}
