// api.utilityThrows: Granatenwürfe aller importierten Matches als Lineup-Vorschläge (shared/utility-capture.ts). Je Match einmal
// entpackt (CS3D: Spuren und Würfe, v1: Seite und Wurfort) und im Speicher gehalten, bis sich eine der Dateien ändert (Re-Import).
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzip } from 'node:zlib'
import { decode3d, roundAt } from '../shared/cs3d.ts'
import type { MatchData, MatchSummary } from '../shared/model.ts'
import type { ThrowCandidate } from '../shared/utility.ts'
import { countSimilar, lineupFromThrow } from '../shared/utility-capture.ts'
import { log } from './log.ts'

const unzip = promisify(gunzip)
const cache = new Map<string, { key: string; list: ThrowCandidate[] }>()

async function throwsOf(dir: string, id: string): Promise<ThrowCandidate[]> {
  const f3 = join(dir, `${id}.3d.bin.gz`), fv = join(dir, `${id}.json.gz`)
  if (!existsSync(f3) || !existsSync(fv)) return [] // alter Import ohne 3D-Daten
  const key = `${statSync(f3).mtimeMs}:${statSync(fv).mtimeMs}`, hit = cache.get(id)
  if (hit?.key === key) return hit.list
  const [b3, bv] = await Promise.all([unzip(readFileSync(f3)), unzip(readFileSync(fv))])
  const d = decode3d(b3), m: MatchData = JSON.parse(bv.toString('utf8'))
  const list: ThrowCandidate[] = []
  for (let i = 0; i < d.nade.type.length; i++) {
    const tick = d.nade.throwTick[i], sid = d.header.players[d.nade.player[i]]?.steamid, r = roundAt(d, tick)
    const R = r < 0 ? undefined : m.rounds.find(x => x.num === d.header.rounds[r].num)
    const side = R?.tracks.find(t => t.steamid === sid)?.side
    if (!side) continue
    const c = lineupFromThrow(d, i, id, side, R!.nades.find(n => n.thrower === sid && n.throwTick === tick)?.throwPlace)
    if (c) list.push(c)
  }
  cache.set(id, { key, list })
  return list
}

/** alle Würfe (map: nur diese Map), similar über alle Demos gezählt */
export async function utilityThrows(dir: string, matches: MatchSummary[], map?: string): Promise<ThrowCandidate[]> {
  const all: ThrowCandidate[] = []
  for (const s of matches) {
    if (map && s.map !== map) continue
    try { for (const c of await throwsOf(dir, s.id)) all.push({ ...c }) } // Kopie: similar hängt von der Auswahl ab
    catch (e) { log.warn(`utility throws ${s.id}: ${e instanceof Error ? e.message : e}`) }
  }
  return countSimilar(all)
}
