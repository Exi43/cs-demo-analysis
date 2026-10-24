// Steam-Profilbilder für das HUD: öffentliches Profil-XML (steamcommunity.com/profiles/<id>?xml=1) → avatarFull → Datei im Cache.
// Cache <dir>/<id>.jpg + index.json { id: { url, fetchedAt } }; ausgeliefert über cs3d://assets3d/avatars/<id>.jpg (handleCs3d).
// Ohne Electron-Import, damit der Selbsttest es mit node laden kann.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assetUrl } from '../shared/assets3d.ts'
import type { Avatars } from '../shared/hud.ts'
import { writeAtomic } from './assets3d/cs2.ts'

const DAY = 864e5, WEEK = 7 * DAY, TIMEOUT = 5000, PARALLEL = 4
/** url = avatarFull oder null (kein Bild, Fehler, Bot) */
type Index = Record<string, { url: string | null; fetchedAt: number }>

const urlOf = (id: string, url: string) => assetUrl(`assets3d/avatars/${id}.jpg?v=${createHash('sha1').update(url).digest('hex').slice(0, 8)}`)

/** SteamID64 → Bild-URL oder null; wirft nie (offline, privat, ungültig → null, neuer Versuch nach 1 Tag) */
export async function getAvatars(ids: unknown[], dir: string): Promise<Avatars> {
  mkdirSync(dir, { recursive: true })
  const idxFile = join(dir, 'index.json'), now = Date.now()
  let idx: Index = {}
  try { idx = JSON.parse(readFileSync(idxFile, 'utf8')) } catch {}
  const out: Avatars = {}, todo: string[] = []
  for (const id of new Set(ids.map(String))) {
    out[id] = null
    if (!/^7656119\d{10}$/.test(id)) continue // Bots ("0", "BOT") und Müll: nie ins Netz, nie in einen Dateinamen
    const e = idx[id], img = join(dir, `${id}.jpg`)
    if (e?.url && existsSync(img)) out[id] = urlOf(id, e.url)
    if (!e || now - e.fetchedAt > (e.url ? WEEK : DAY) || (e.url && !out[id])) todo.push(id)
  }
  const one = async (id: string) => {
    const old = idx[id], img = join(dir, `${id}.jpg`)
    try {
      const res = await fetch(`https://steamcommunity.com/profiles/${id}?xml=1`, { signal: AbortSignal.timeout(TIMEOUT) })
      if (!res.ok) throw new Error(`profile ${res.status}`) // 429/5xx: nicht als "kein Bild" merken
      const xml = await res.text()
      const url = /<avatarFull>\s*(?:<!\[CDATA\[)?\s*(https:\/\/[^\s<>\]"]+)/.exec(xml)?.[1] ?? null
      if (url && (url !== old?.url || !existsSync(img))) {
        const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) })
        if (!r.ok || !r.headers.get('content-type')?.startsWith('image/')) throw new Error(`avatar ${r.status}`)
        writeAtomic(img, new Uint8Array(await r.arrayBuffer()))
      }
      idx[id] = { url, fetchedAt: now }
      out[id] = url && urlOf(id, url)
    } catch {
      // offline/Timeout: altes Bild behalten, in 1 Tag neu versuchen
      idx[id] = old?.url && out[id] ? { url: old.url, fetchedAt: now - WEEK + DAY } : { url: null, fetchedAt: now }
    }
  }
  const fetched = todo.length
  await Promise.all(Array.from({ length: PARALLEL }, async () => { for (let id; (id = todo.shift());) await one(id) }))
  if (fetched) try { writeAtomic(idxFile, JSON.stringify(idx)) } catch {} // Cache nur Komfort: Schreibfehler → nächstes Mal neu laden
  return out
}
