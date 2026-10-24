// Jede Runde eines Teams einordnen: T-Spielzug (Tags, Laufwege, Rollen, Post-Plant) bzw. CT-Setup (Positionen, Pushes, Rotationen).
// Regeln und Messwerte aus dem Spike proanalyse/erkennung (proto.ts), siehe docs/Analyse-Regeln.md.
import type { BuyType, MatchData, PlayerTrack, Round, Side } from '../model.ts'
import { frameAtSec, type Geo } from './geo.ts'
import { calloutName, laneSite, nadeInput, nadeName } from './maps/index.ts'
import type { CTRoundPro, TRoundPro, Util } from './types.ts'

export interface Ref { matchId: string; round: number; tick: number }

export interface TRound extends TRoundPro {
  kind: 'T'
  ref: Ref
  matchId: string
  round: number
  buy: BuyType
  won: boolean
  site?: 'A' | 'B'
  hitSec?: number
  opening?: { killer?: string; victim: string; place: string; sec: number; forUs: boolean }
}

export interface CTRound extends CTRoundPro {
  kind: 'CT'
  ref: Ref
  matchId: string
  round: number
  buy: BuyType
  won: boolean
  opening?: { killer?: string; victim: string; place: string; sec: number; forUs: boolean }
}

const SITE_ZONES: ('A' | 'B')[] = ['A', 'B']
const secOf = (r: Round, tick: number) => (tick - r.freezeEndTick) / 64
const alive = (t: PlayerTrack, f: number) => t.hp[f] > 0
const dist = (x: number, y: number, p: [number, number]) => Math.hypot(x - p[0], y - p[1])
const placeAt = (r: Round, t: PlayerTrack, f: number) => r.places[t.place[f]] ?? ''
const isSiteLane = (l: string) => l === 'A site' || l === 'B site'

export function teamSide(r: Round, team: string): Side { return r.teamOnSide.CT === team ? 'CT' : 'T' }

/** Ende eines Pushs ab Ankunft s: bis er den Bereich 3 s lang verlässt oder stirbt, max. 40 s. Kills/Tod bis dahin zählen zum Push
 *  (Dust2 R11: sk1nnex hält Catwalk von 9 bis 30 s und tötet bei 21/23/27 s; ein festes Fenster von 12 s verpasste zwei davon) */
export function pushEnd(r: Round, t: PlayerTrack, s: number, inArea: (f: number) => boolean): number {
  let end = s
  for (let x = s + 1; x <= 40 && x - end <= 3; x++) {
    const f = frameAtSec(r, x)
    if (!alive(t, f)) return x
    if (inArea(f)) end = x
  }
  return end + 1
}

function opening(m: MatchData, r: Round, side: Side, geo: Geo) {
  const k = r.kills.find(k => k.attacker)
  if (!k) return undefined
  const victimSide = r.tracks.find(t => t.steamid === k.victim)?.side
  return {
    killer: k.attacker, victim: k.victim, sec: (k.tick - r.freezeEndTick) / 64,
    place: calloutName(geo.map, k.victimPlace || geo.nearestPlace(k.victimPos[0], k.victimPos[1], k.victimPos[2])) || '?',
    forUs: victimSide !== side,
  }
}

/** Granaten einer Seite (ohne Decoys, ab 1 s vor Freezetime-Ende): Wurfort aus der Spielerspur, Landeort + Lineup-Name über P1 */
function utilOf(r: Round, side: Side, geo: Geo): Util[] {
  const out: Util[] = []
  for (const n of r.nades) {
    if (n.type === 'decoy' || n.throwTick < r.freezeEndTick - 64) continue
    const tr = r.tracks.find(t => t.steamid === n.thrower), s0 = n.path[0], e = n.path[n.path.length - 1]
    if (tr?.side !== side || !e) continue
    const from = placeAt(r, tr, frameAtSec(r, secOf(r, n.throwTick))) || geo.nearestPlace(s0[1], s0[2], s0[3])
    const to = geo.nearestPlace(e[1], e[2], e[3])
    const nn = nadeName(geo.map, nadeInput(n, side))
    out.push({ thrower: n.thrower, side, type: n.type, sec: secOf(r, n.throwTick), from: calloutName(geo.map, from), to: calloutName(geo.map, to),
      lane: geo.lane(to), name: nn.name, named: nn.named, land: [e[1], e[2], e[3]] })
  }
  return out.sort((a, b) => a.sec - b.sec)
}

export function classifyT(m: MatchData, r: Round, team: string, geo: Geo): TRound {
  const ts = r.tracks.filter(t => t.side === 'T'), cts = r.tracks.filter(t => t.side === 'CT')
  const end = r.frameTicks.length - 1
  const F = (s: number) => frameAtSec(r, s)
  const won = r.winner === 'T'
  const laneAt = (t: PlayerTrack, f: number) => geo.lane(placeAt(r, t, f) || geo.nearestPlace(t.x[f], t.y[f]))
  let hitF: number | undefined, site: 'A' | 'B' | undefined
  // Hit = erster Moment mit ≥3 lebenden T direkt auf einer Site (oder 2, wenn nur noch ≤3 leben)
  for (let f = F(0); f <= end && hitF === undefined; f += 2) {
    const alv = ts.filter(t => t.hp[f] > 0)
    const need = alv.length <= 3 ? Math.min(2, alv.length) : 3
    if (!need) break
    for (const z of SITE_ZONES) {
      if (alv.filter(t => geo.siteAt(t.x[f], t.y[f]) === z).length >= need) { hitF = f; site = z; break }
    }
  }
  if (r.plant) {
    const pf = F(secOf(r, r.plant.tick))
    // Plant vor dem erkannten Hit oder auf der anderen Site (Rotation) → Plant ist der Hit
    if (hitF === undefined || pf < hitF || (r.plant.site && r.plant.site !== site)) hitF = pf
    site = r.plant.site ?? site
  }
  if (!site) hitF = undefined
  const aliveEnd = ts.filter(t => t.hp[end] > 0).length
  const save = hitF === undefined && !won && aliveEnd >= 2 && !r.reason.includes('time') && r.buy.T === 'eco'
  let hitSec = hitF !== undefined ? secOf(r, r.frameTicks[hitF]) : undefined

  // Eintritte: Laufweg, in dem der Spieler in den 6 s vor dem Betreten am längsten war
  // (Nav-Callouts wie Mirage "PalaceInterior" reichen bis an die Site, der letzte Callout allein täuscht)
  let entries: TRoundPro['entries'] = []
  if (site && hitSec !== undefined) {
    const f0 = F(Math.max(0, hitSec - 15)), f1 = F(hitSec + 20)
    for (const t of ts) {
      for (let f = f0; f <= f1; f++) {
        if (!alive(t, f)) break
        if (geo.siteAt(t.x[f], t.y[f]) !== site) continue
        const cnt = new Map<string, number>()
        for (let g = f; g >= Math.max(0, f - 16 * 6); g -= 2) { const l = laneAt(t, g); if (!isSiteLane(l)) cnt.set(l, (cnt.get(l) ?? 0) + 1) }
        let lane = [...cnt].sort((a, b) => b[1] - a[1])[0]?.[0]
        for (let g = f; !lane && g >= Math.max(0, f - 16 * 20); g -= 4) { const l = laneAt(t, g); if (!isSiteLane(l)) lane = l }
        entries.push({ id: t.steamid, sec: secOf(r, r.frameTicks[f]), lane: lane || '?' }); break
      }
    }
    entries.sort((a, b) => a.sec - b.sec)
    // Ein einzelner Überlebender auf der Site ist kein Hit (die Schwelle oben sinkt auf 1, wenn nur 1 lebt)
    if (!r.plant && entries.filter(e => e.sec <= hitSec! + 10).length < 2) { site = undefined; hitSec = hitF = undefined; entries = [] }
  }
  const sc = site === 'A' ? geo.siteA : site === 'B' ? geo.siteB : undefined
  const oc = site === 'A' ? geo.siteB : site === 'B' ? geo.siteA : undefined
  // Entry = erster T auf der Site, nur wenn spätestens 5 s nach dem Hit (sonst kam er nach)
  const entry = entries[0] && entries[0].sec <= (hitSec ?? 0) + 5 ? entries[0].id : undefined

  const lanes20: Record<string, string[]> = {}
  const f20 = Math.min(end, F(20))
  for (const t of ts) if (alive(t, f20)) (lanes20[laneAt(t, f20)] ??= []).push(t.steamid)

  const util = utilOf(r, 'T', geo), tUtil = util.filter(u => u.type !== 'he')
  // Execute-Util: Smokes/Flashes/Mollys nahe der Hit-Site, 15 s vor bis 3 s nach dem Hit
  const near = (u: Util, p: [number, number]) => dist(u.land[0], u.land[1], p) < 1.4 * geo.siteR
  const execUtil = sc && hitSec !== undefined ? tUtil.filter(u => u.sec >= hitSec! - 15 && u.sec <= hitSec! + 3 && near(u, sc)) : []
  // Fake-Util: landet an der anderen Site, ab 10 s bis 3 s vor dem Hit
  const fakeUtil = oc && hitSec !== undefined ? tUtil.filter(u => u.sec >= 10 && u.sec <= hitSec! - 3 && near(u, oc) && !near(u, sc!)) : []
  // Bewegungs-Fake: ≥ 3 T gleichzeitig an der anderen Site (ihre Laufwege oder < 1,6 siteR) außerhalb der T-Hälfte, 10 s bis Hit −8 s
  let fakeBodies = 0
  if (site && oc && hitSec !== undefined) {
    const other = site === 'A' ? 'B' : 'A'
    for (let s = 10; s <= hitSec - 8; s += 2) {
      const f = F(s)
      fakeBodies = Math.max(fakeBodies, ts.filter(t => {
        if (!alive(t, f)) return false
        const p = placeAt(r, t, f)
        return (dist(t.x[f], t.y[f], oc) < 1.6 * geo.siteR || laneSite(geo.lane(p)) === other) && geo.tAt(t.x[f], t.y[f], p) < 0.75
      }).length)
    }
  }

  // Lurker: in den 25 s vor dem Hit meist allein (nächster Mitspieler > 1000 u) und > 1,5 siteR von der Hit-Site.
  // Ohne Hit kein Lurker (in verteilten Eco-/No-Hit-Runden ist jeder allein)
  const lurkersPro: string[] = []
  if (sc && hitSec !== undefined) {
    const fa = F(Math.max(10, hitSec - 25)), fb = F(hitSec + 5)
    for (const t of ts) {
      // wer beim Hit schon auf der Site ist, lurkt nicht; späte Flanker über eine andere Lane schon
      if (entries.some(e => e.id === t.steamid && e.sec <= hitSec!)) continue
      let n = 0, lone = 0
      for (let f = fa; f <= fb && alive(t, f); f += 8) {
        const others = ts.filter(o => o !== t && alive(o, f))
        if (!others.length) continue // letzter Überlebender: kein Lurker-Signal
        n++
        const nearest = Math.min(...others.map(o => Math.hypot(o.x[f] - t.x[f], o.y[f] - t.y[f])))
        if (nearest > 1000 && dist(t.x[f], t.y[f], sc) > 1.5 * geo.siteR) lone++
      }
      if (n >= 10 && lone / n >= 0.7) lurkersPro.push(t.steamid)
    }
  }
  // Support: wirft ≥ 2 Execute-Granaten und ist nicht der Entry
  const byThrower = new Map<string, number>()
  for (const u of execUtil) byThrower.set(u.thrower, (byThrower.get(u.thrower) ?? 0) + 1)
  const support = [...byThrower].filter(([id, n]) => n >= 2 && id !== entry).map(([id]) => id)
  const awp = ts.filter(t => t.inventory.includes('AWP') || r.weapons[t.weapon[f20]] === 'AWP').map(t => t.steamid)

  // Tags (kombinierbar): default / fake X / rush / execute / split / hit, ohne Hit "no hit (A side)" bzw. "save (B side)"
  const tags: string[] = []
  const entryLanes = [...new Set(entries.filter(e => e.sec <= hitSec! + 12).map(e => e.lane))].filter(l => l !== '?')
  const busyLanes20 = Object.entries(lanes20).filter(([l]) => l !== 'T spawn')
  // Default: Karte erst kontrollieren, spät treffen (≥ 3 Lanes bei 20 s mit max. 3 je Lane, oder Hit ≥ 60 s)
  const spread = busyLanes20.length >= 3 && Math.max(0, ...busyLanes20.map(([, v]) => v.length)) <= 3
  if ((hitSec === undefined || hitSec >= 45) && (spread || (hitSec ?? 0) >= 60)) tags.push('default')
  if (site && (fakeUtil.length >= 2 || fakeBodies >= 3)) tags.push(`fake ${site === 'A' ? 'B' : 'A'}`)
  if (site) {
    if (hitSec! <= 30 && entries.filter(e => e.sec <= hitSec! + 8).length >= 4) tags.push('rush')
    if (execUtil.length >= 3 && execUtil.some(u => u.type === 'smoke')) tags.push('execute')
    if (entryLanes.length >= 2) tags.push('split')
    if (!tags.some(x => x === 'rush' || x === 'execute' || x === 'split')) tags.push('hit')
  } else {
    // Seite ohne Hit: wo die T ab 20 s die meiste Zeit standen
    const side = new Map<string, number>()
    for (let s = 20; s <= Math.min(90, secOf(r, r.endTick)); s += 2) {
      const f = F(s)
      for (const t of ts) if (alive(t, f)) { const k = laneSite(laneAt(t, f)); if (k === 'A' || k === 'B') side.set(k, (side.get(k) ?? 0) + 1) }
    }
    const top = [...side].sort((a, b) => b[1] - a[1])[0]
    tags.push((save ? 'save' : 'no hit') + (top ? ` (${top[0]} side)` : ''))
  }
  const label = `${site ?? ''} ${tags.join(' + ')}${entryLanes.length ? ` via ${entryLanes.join(' & ')}` : ''}`.trim()

  // Erster Kontakt: erster Schaden zwischen den Teams
  const sideOf = (s?: string) => r.tracks.find(t => t.steamid === s)?.side
  const fd = r.damages.find(d => d.attacker && sideOf(d.attacker) && sideOf(d.attacker) !== sideOf(d.victim))
  const fv = fd && r.tracks.find(t => t.steamid === fd.victim)
  let firstContact: TRoundPro['firstContact']
  if (fd && fv) {
    const f = F(secOf(r, fd.tick)), pl = placeAt(r, fv, f) || geo.nearestPlace(fv.x[f], fv.y[f])
    firstContact = { sec: secOf(r, fd.tick), place: calloutName(geo.map, pl), lane: geo.lane(pl), tDealt: sideOf(fd.attacker) === 'T' }
  }
  // Mid-Kontrolle: erste Sekunde, in der ein T einen Mid-Callout außerhalb der T-Hälfte hält
  let midT: number | undefined
  for (let s = 0; s <= Math.min(60, hitSec ?? 60) && midT === undefined; s++) {
    const f = F(s)
    if (ts.some(t => { if (!alive(t, f)) return false; const p = placeAt(r, t, f); return geo.lane(p) === 'Mid' && geo.tAt(t.x[f], t.y[f], p) < 0.75 })) midT = s
  }

  // Plant: Post-Plant der T (8 s danach ≤ 700 u = on site), Retake-Versuch der CT (≥ 500 u näher oder < 600 u an der Bombe)
  let plantInfo: TRoundPro['plantInfo']
  if (r.plant) {
    const ps = secOf(r, r.plant.tick), fp = F(ps), f8 = F(ps + 8), bp: [number, number] = [r.plant.pos[0], r.plant.pos[1]]
    const tAlive = ts.filter(t => alive(t, fp)), ctAlive = cts.filter(t => alive(t, fp))
    const on = tAlive.filter(t => alive(t, f8) && dist(t.x[f8], t.y[f8], bp) <= 700).length
    const off = tAlive.filter(t => alive(t, f8) && dist(t.x[f8], t.y[f8], bp) > 700).length
    const fe = F(Math.min(ps + 40, secOf(r, r.endTick)))
    const retakers = ctAlive.filter(t => {
      const d0 = dist(t.x[fp], t.y[fp], bp); let dmin = d0
      for (let f = fp; f <= fe && alive(t, f); f++) dmin = Math.min(dmin, dist(t.x[f], t.y[f], bp))
      return d0 - dmin >= 500 || dmin < 600
    }).map(t => t.steamid)
    plantInfo = {
      sec: ps, site: r.plant.site, player: r.plant.player, tAlive: tAlive.length, ctAlive: ctAlive.length,
      postPlant: on >= off ? `on site ${on}/off ${off}` : `off site ${off}/on ${on}`,
      retake: !ctAlive.length ? 'no-ct' : !retakers.length ? 'save' : r.defuse ? 'won-defuse' : r.winner === 'CT' ? 'won-kills' : 'lost', retakers,
    }
  }

  // Signatur für Spielzug-Cluster: Site, Eintritts-Lanes, Lane-Verteilung bei 20 s, Smokes/Mollys bis Hit +3 s (Typ + Landeort)
  const sig = [
    `site:${site ?? '-'}`,
    ...entryLanes.map(l => `in:${l}`),
    ...busyLanes20.map(([l, v]) => `l20:${l}:${Math.min(v.length, 3)}`),
    ...new Set(tUtil.filter(u => u.type !== 'flash' && (hitSec === undefined || u.sec <= hitSec + 3)).map(u => `${u.type}:${u.to}`)),
  ]

  return {
    kind: 'T', ref: { matchId: m.id, round: r.num, tick: hitF !== undefined ? r.frameTicks[hitF] : r.freezeEndTick }, matchId: m.id, round: r.num,
    buy: r.buy.T, won, site, hitSec, opening: opening(m, r, 'T', geo),
    tags, label, entries, entry, lurkersPro, support, awp, lanes20, util, execUtil, fakeUtil, firstContact, midT, plantInfo, sig,
  }
}

/** CT-Bereich eines Places: A / B / Mid / CT (Laufweg, sonst Zone) */
function ctArea(geo: Geo, place: string): string {
  const s = laneSite(geo.lane(place))
  if (s === 'A' || s === 'B' || s === 'CT') return s
  const p = geo.place.get(place); if (!p) return 'Mid'
  const z = geo.zoneAt(p.x, p.y); return z === 'A' || z === 'B' ? z : 'Mid'
}

/** tr = T-Analyse derselben Runde (für Rotationen und Retakes); ohne Angabe wird sie berechnet */
export function classifyCT(m: MatchData, r: Round, team: string, geo: Geo, tr = classifyT(m, r, r.teamOnSide.T, geo)): CTRound {
  const cts = r.tracks.filter(t => t.side === 'CT')
  const F = (s: number) => frameAtSec(r, s)
  const f15 = F(15)
  const name = (p: string) => calloutName(geo.map, p)
  const posAt = (f: number) => Object.fromEntries(cts.filter(c => alive(c, f)).map(c => [c.steamid, placeAt(r, c, f) || geo.nearestPlace(c.x[f], c.y[f])]))
  const raw15 = posAt(f15), raw25 = posAt(F(25))
  const lanes = new Map<string, number>()
  for (const p of Object.values(raw15)) { const l = geo.lane(p); lanes.set(l, (lanes.get(l) ?? 0) + 1) }
  const setup15 = [...lanes].sort().map(([l, n]) => `${l} ${n}`).join(' · ')
  const awpSpot = cts.filter(c => c.inventory.includes('AWP') && raw15[c.steamid]).map(c => ({ id: c.steamid, place: name(raw15[c.steamid]) }))

  // Frühe Aggression in den ersten 30 s. push = T-Hälfte: Zelle klar T (≥ 0,75) oder T-Place (≥ 0,75), dessen Zelle nicht CT-eigen ist (≥ 0,5).
  // Nur Place: Fehltreffer (Mirage PalaceInterior reicht bis an die Site); nur Zelle: verfehlt Ränder (Dust2 Top Mid 0,69).
  // forward = bis 25 s auf umkämpftem Boden (T-Anteil ≥ 0,4), z. B. Dust2 Catwalk / Pit
  const aggression: CTRoundPro['aggression'] = []
  for (const c of cts) {
    let hit: { s: number; p: string; level: 'push' | 'forward' } | undefined
    for (let s = 2; s <= 30; s++) {
      const f = F(s); if (!alive(c, f)) break
      const p = placeAt(r, c, f), cs = geo.tCell(c.x[f], c.y[f]), ps = geo.tShare.get(p) ?? 0
      if ((cs !== undefined && cs >= 0.75) || (ps >= 0.75 && (cs === undefined || cs >= 0.5)) || geo.lane(p) === 'T spawn') { hit = { s, p, level: 'push' }; break }
      if (!hit && s <= 25 && geo.tAt(c.x[f], c.y[f], p) >= 0.4) hit = { s, p, level: 'forward' }
    }
    if (!hit) continue
    const end = pushEnd(r, c, hit.s, f => geo.tAt(c.x[f], c.y[f], placeAt(r, c, f)) >= 0.4)
    const k = r.kills.filter(k => secOf(r, k.tick) <= end)
    aggression.push({ id: c.steamid, place: name(hit.p), sec: hit.s, level: hit.level, kills: k.filter(k => k.attacker === c.steamid).length, died: k.some(k => k.victim === c.steamid) })
  }

  // Rotationen: bei 15 s > 1,5 siteR weg und nicht im Hit-Bereich, Ankunft < siteR zwischen Hit −10 s und Plant/Hit +25 s
  const rotations: CTRoundPro['rotations'] = []
  if (tr.site && tr.hitSec !== undefined) {
    const sc = tr.site === 'A' ? geo.siteA : geo.siteB, hitSec = tr.hitSec
    const fEnd = F(Math.min(secOf(r, r.endTick), (tr.plantInfo?.sec ?? hitSec) + 25))
    for (const c of cts) {
      const p15 = raw15[c.steamid]; if (!p15) continue
      const a15 = ctArea(geo, p15)
      if (a15 === tr.site || dist(c.x[f15], c.y[f15], sc) < 1.5 * geo.siteR) continue
      let arrive: number | undefined
      for (let f = f15; f <= fEnd && alive(c, f); f++) if (dist(c.x[f], c.y[f], sc) < geo.siteR) { arrive = secOf(r, r.frameTicks[f]); break }
      // Ankunft > 10 s vor dem Hit = Umstellung/Stack, keine Rotation auf diesen Hit
      if (arrive === undefined || arrive < hitSec - 10) continue
      // CT-Spawn direkt an der Site (Mirage/Dust2 A): Schritt auf die Site ist keine Rotation
      if (geo.lane(p15) === 'CT' && dist(geo.ctSpawn[0], geo.ctSpawn[1], sc) < 2 * geo.siteR) continue
      // Start = Moment, in dem er seinen Bereich von 15 s endgültig verlässt (rückwärts von der Ankunft)
      let fs = F(arrive)
      while (fs > f15 && ctArea(geo, placeAt(r, c, fs - 1) || geo.nearestPlace(c.x[fs - 1], c.y[fs - 1])) !== a15) fs--
      const startSec = secOf(r, r.frameTicks[fs])
      // Letzter Halt = Ende der letzten Halte-Position vor der Ankunft (rückwärts, solange er ≥ 60 u/s läuft)
      let fh = F(arrive)
      while (fh - 16 >= f15 && Math.hypot(c.x[fh] - c.x[fh - 16], c.y[fh] - c.y[fh - 16]) >= 60) fh -= 8
      // Nur Rotationen, die mit diesem Hit zu tun haben (Start frühestens 40 s vor dem Hit)
      if (startSec < hitSec - 40) continue
      rotations.push({ id: c.steamid, from: name(p15), startSec, arriveSec: arrive, vsHit: startSec - hitSec, lastHold: secOf(r, r.frameTicks[fh]) })
    }
  }
  const util = utilOf(r, 'CT', geo)

  return {
    kind: 'CT', ref: { matchId: m.id, round: r.num, tick: r.freezeEndTick + 15 * 64 }, matchId: m.id, round: r.num,
    buy: r.buy.CT, won: r.winner === 'CT',
    opening: opening(m, r, 'CT', geo),
    pos15: Object.fromEntries(Object.entries(raw15).map(([id, p]) => [id, name(p)])), pos25: Object.fromEntries(Object.entries(raw25).map(([id, p]) => [id, name(p)])),
    setup15, awpSpot, aggression, rotations, util,
  }
}

export function classifyRounds(m: MatchData, team: string, geo: Geo): (TRound | CTRound)[] {
  return m.rounds.map(r => (teamSide(r, team) === 'T' ? classifyT(m, r, team, geo) : classifyCT(m, r, team, geo)))
}
