// Liest eine CS2-Demo (.dem / .dem.gz / .dem.zst) und baut daraus MatchData.
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { decompress as zstdDecompress } from 'fzstd'
import { unzipSync } from 'fflate'
import * as dp from '@laihoe/demoparser2'
import {
  DATA_VERSION, FRAME_STEP,
  type BombEvent, type Blind, type BuyType, type Damage, type Kill, type MatchData,
  type Nade, type NadeType, type PlayerInfo, type PlayerTrack, type Round, type Side,
} from '../shared/model.ts'

type Row = Record<string, any>
type Progress = (pct: number, msg: string) => void

const TRADE_WINDOW_S = 5

export function readDemoBuffer(raw: Buffer): Buffer {
  if (raw[0] === 0x1f && raw[1] === 0x8b) return gunzipSync(raw)
  if (raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd) return Buffer.from(zstdDecompress(raw))
  if (raw[0] === 0x50 && raw[1] === 0x4b && raw[2] === 0x03 && raw[3] === 0x04) {
    // ZIP: größte Demo darin nehmen (auch .dem.gz/.dem.zst im ZIP)
    const files = unzipSync(raw, { filter: f => /\.dem(\.gz|\.zst)?$/i.test(f.name) })
    const best = Object.values(files).sort((a, b) => b.length - a.length)[0]
    if (!best) throw new Error('No .dem file found in the ZIP')
    return readDemoBuffer(Buffer.from(best.buffer, best.byteOffset, best.length))
  }
  return raw
}

const sideOf = (teamNum: any): Side | undefined =>
  teamNum === 2 || teamNum === 'T' || teamNum === 'TERRORIST' ? 'T'
    : teamNum === 3 || teamNum === 'CT' ? 'CT' : undefined

const sid = (v: any): string | undefined => (v == null || v === '' || v === '0' || v === 0 ? undefined : String(v))
const r1 = (n: number) => Math.round(n * 10) / 10

function nadeType(s: string): NadeType | undefined {
  const t = s.toLowerCase()
  if (t.includes('smoke')) return 'smoke'
  if (t.includes('flash')) return 'flash'
  if (t.includes('hegrenade')) return 'he'
  if (t.includes('molotov') || t.includes('incendiary')) return 'molotov'
  if (t.includes('decoy')) return 'decoy'
  return undefined
}

function siteFromPlace(place: string | undefined): 'A' | 'B' | undefined {
  if (!place) return undefined
  const m = /bombsite\s*([ab])/i.exec(place)
  return m ? (m[1].toUpperCase() as 'A' | 'B') : undefined
}

/** Buy-Typ aus Team-Equipment-Wert bei Freezetime-Ende. Pistol separat. */
export function classifyBuy(halfStart: boolean, teamEquip: number): BuyType {
  // Erste Runde einer Halbzeit mit Startgeld 800 $; OT-Halbzeiten starten mit viel Geld und zählen nicht
  if (halfStart && teamEquip <= 6000) return 'pistol'
  if (teamEquip < 6000) return 'eco'
  if (teamEquip < 20000) return 'force'
  return 'full'
}

/** parseEvents liefert je nach Version ein Array oder ein Objekt pro Event-Name. */
function groupEvents(res: any): Record<string, Row[]> {
  const out: Record<string, Row[]> = {}
  const rows: Row[] = Array.isArray(res) ? res : Object.values(res ?? {}).flat() as Row[]
  for (const r of rows) (out[r.event_name] ??= []).push(r)
  for (const k in out) out[k].sort((a, b) => a.tick - b.tick)
  return out
}

/** structOfArrays → Zeilen-Zugriff ohne Kopie */
function columns(res: any): { n: number; col: (k: string) => any[] } {
  if (Array.isArray(res)) {
    return { n: res.length, col: k => res.map((r: Row) => r[k]) }
  }
  const n = (res.tick ?? Object.values(res)[0] ?? []).length
  return { n, col: k => res[k] ?? [] }
}

export function parseDemo(raw: Buffer, fileName: string, progress: Progress = () => {}): MatchData {
  const buf = readDemoBuffer(raw)
  const id = createHash('sha1').update(buf.subarray(0, 1 << 20)).update(String(buf.length)).digest('hex').slice(0, 16)

  progress(5, 'Reading header')
  const header = dp.parseHeader(buf) ?? {}
  const map: string = header.map_name ?? 'unknown'
  const tickrate = 64

  progress(10, 'Reading events')
  const eventNames = [
    'round_start', 'round_freeze_end', 'round_end', 'round_officially_ended',
    'player_death', 'player_hurt', 'player_blind',
    'bomb_planted', 'bomb_defused', 'bomb_exploded',
    'smokegrenade_detonate', 'smokegrenade_expired', 'inferno_startburn', 'inferno_expire',
    'flashbang_detonate', 'hegrenade_detonate', 'decoy_started',
  ]
  const ev = groupEvents(dp.parseEvents(buf, eventNames,
    ['X', 'Y', 'Z', 'last_place_name', 'team_num'],
    ['total_rounds_played', 'is_warmup_period']))
  const E = (name: string) => ev[name] ?? []

  // --- Runden-Grenzen ---------------------------------------------------
  const roundEnds = E('round_end').filter(r => !r.is_warmup_period && sideOf(r.winner))
  const freezeEnds = E('round_freeze_end').map(r => r.tick as number)
  const starts = E('round_start').map(r => r.tick as number)
  const lastBefore = (arr: number[], t: number, fallback: number) => {
    let best = fallback
    for (const x of arr) if (x <= t) best = x; else break
    return best
  }

  interface RB { startTick: number; freezeEndTick: number; endTick: number; winner: Side; reason: string }
  const bounds: RB[] = []
  for (const re of roundEnds) {
    const freezeEndTick = lastBefore(freezeEnds, re.tick, re.tick)
    const startTick = lastBefore(starts, freezeEndTick, freezeEndTick - 20 * tickrate)
    // Restart/Backup: Runde, die vor dem Ende der vorigen beginnt, ersetzt diese
    while (bounds.length && bounds[bounds.length - 1].endTick > startTick) bounds.pop()
    bounds.push({ startTick, freezeEndTick, endTick: re.tick, winner: sideOf(re.winner)!, reason: String(re.reason ?? '') })
  }
  // Nach Rundenende noch 4 s zeigen (Exit-Frags, Saves)
  const AFTER = 4 * tickrate
  for (let i = 0; i < bounds.length; i++) {
    const next = bounds[i + 1]?.startTick ?? Infinity
    ;(bounds[i] as any).viewEnd = Math.min(bounds[i].endTick + AFTER, next - 1)
  }

  // --- Positionen -------------------------------------------------------
  progress(25, 'Reading positions')
  const wanted: number[] = []
  for (const b of bounds) {
    const end = (b as any).viewEnd as number
    for (let t = b.startTick - (b.startTick % FRAME_STEP); t <= end; t += FRAME_STEP) wanted.push(t)
  }
  const props = ['X', 'Y', 'Z', 'yaw', 'health', 'armor_value', 'active_weapon_name', 'last_place_name',
    'balance', 'team_num', 'is_alive']
  const ticks = columns(dp.parseTicks(buf, props, wanted, null, true))
  const c = {
    tick: ticks.col('tick'), steamid: ticks.col('steamid'), name: ticks.col('name'),
    X: ticks.col('X'), Y: ticks.col('Y'), Z: ticks.col('Z'), yaw: ticks.col('yaw'),
    hp: ticks.col('health'), armor: ticks.col('armor_value'), weapon: ticks.col('active_weapon_name'),
    place: ticks.col('last_place_name'), money: ticks.col('balance'), team: ticks.col('team_num'),
    alive: ticks.col('is_alive'),
  }

  progress(45, 'Reading equipment')
  const feTicks = bounds.map(b => b.freezeEndTick)
  const fe = columns(dp.parseTicks(buf,
    ['current_equip_value', 'inventory', 'has_defuser', 'has_helmet', 'team_num', 'team_clan_name'], feTicks, null, true))
  const feCol = {
    tick: fe.col('tick'), steamid: fe.col('steamid'), name: fe.col('name'), equip: fe.col('current_equip_value'),
    inv: fe.col('inventory'), defuser: fe.col('has_defuser'), helmet: fe.col('has_helmet'),
    team: fe.col('team_num'), clan: fe.col('team_clan_name'),
  }

  // Knife-Runde: niemand hat eine Schusswaffe → Runde verwerfen
  const hasGun = new Set<number>()
  for (let i = 0; i < fe.n; i++) {
    const inv: string[] = Array.isArray(feCol.inv[i]) ? feCol.inv[i] : []
    if (inv.some(w => !/knife|bayonet|karambit|dagger|c4|bomb|taser|zeus|grenade|molotov|flash|smoke|decoy|incendiary/i.test(w))) hasGun.add(feCol.tick[i])
  }
  for (let i = bounds.length - 1; i >= 0; i--) if (!hasGun.has(bounds[i].freezeEndTick)) bounds.splice(i, 1)

  // --- Spieler + Teams --------------------------------------------------
  const playerName = new Map<string, string>()
  const playerClan = new Map<string, string>()
  const sideAtRound = new Map<number, Map<string, Side>>() // freezeEndTick → steamid → Seite
  for (let i = 0; i < fe.n; i++) {
    const s = sid(feCol.steamid[i]); const side = sideOf(feCol.team[i])
    if (!s || !side) continue
    playerName.set(s, feCol.name[i])
    if (feCol.clan[i]) playerClan.set(s, String(feCol.clan[i]))
    let m = sideAtRound.get(feCol.tick[i]); if (!m) sideAtRound.set(feCol.tick[i], m = new Map())
    m.set(s, side)
  }

  // Team = Spieler, die in Runde 1 zusammen auf einer Seite waren (Clan-Namen nur als Label)
  const firstSides = sideAtRound.get(bounds[0]?.freezeEndTick) ?? new Map<string, Side>()
  const teamKey = new Map<string, 0 | 1>()
  for (const [s, side] of firstSides) teamKey.set(s, side === 'CT' ? 0 : 1)
  // Spät eingestiegene Spieler: über die Seite in ihrer ersten Runde zuordnen
  for (const b of bounds) {
    const m = sideAtRound.get(b.freezeEndTick); if (!m) continue
    const half = (bounds.indexOf(b) < 12) === true
    for (const [s, side] of m) if (!teamKey.has(s)) teamKey.set(s, (side === 'CT') === half ? 0 : 1)
  }
  const clanOf = (k: 0 | 1) => {
    const counts = new Map<string, number>()
    for (const [s, t] of teamKey) if (t === k && playerClan.get(s)) counts.set(playerClan.get(s)!, (counts.get(playerClan.get(s)!) ?? 0) + 1)
    const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
    return best ? best.replace(/^team_/, '') : k === 0 ? 'Team A (started CT)' : 'Team B (started T)'
  }
  const teams = [clanOf(0), clanOf(1)]
  if (teams[0] === teams[1]) teams[1] += ' (2)'
  const players: PlayerInfo[] = [...teamKey].map(([s, k]) => ({ steamid: s, name: playerName.get(s) ?? s, team: teams[k] }))
  const teamOfPlayer = new Map(players.map(p => [p.steamid, p.team]))

  // --- Granaten ---------------------------------------------------------
  progress(60, 'Reading grenades')
  // false = nur Projektile (Flugbahnen); mit true ist es ~6x langsamer
  const gr = columns(dp.parseGrenades(buf, null, false))
  const g = {
    type: gr.col('grenade_type'), id: gr.col('grenade_entity_id'), x: gr.col('x'), y: gr.col('y'), z: gr.col('z'),
    tick: gr.col('tick'), thrower: gr.col('steamid'),
  }
  interface RawNade { id: number; type: NadeType; thrower: string; path: [number, number, number, number][] }
  const rawNades: RawNade[] = []
  const active = new Map<string, RawNade>()
  for (let i = 0; i < gr.n; i++) {
    const t = nadeType(String(g.type[i] ?? '')); if (!t || g.x[i] == null) continue
    const key = `${g.id[i]}:${t}`
    let n = active.get(key)
    const last = n?.path[n.path.length - 1]
    // Entity-IDs werden wiederverwendet: großer Zeitsprung oder anderer Werfer = neue Granate
    const thrower = sid(g.thrower[i]) ?? ''
    if (!n || (last && g.tick[i] - last[0] > 2 * tickrate) || n.thrower !== thrower) {
      n = { id: Number(g.id[i]), type: t, thrower, path: [] }
      active.set(key, n); rawNades.push(n)
    }
    const prev = n.path[n.path.length - 1]
    if (!prev || g.tick[i] - prev[0] >= 2) n.path.push([g.tick[i], r1(g.x[i]), r1(g.y[i]), r1(g.z[i])])
  }

  progress(75, 'Building rounds')
  const detByEntity = (name: string) => {
    const m = new Map<number, Row[]>()
    for (const r of E(name)) { const k = Number(r.entityid); (m.get(k) ?? m.set(k, []).get(k)!).push(r) }
    return m
  }
  const smokeDet = detByEntity('smokegrenade_detonate')
  const smokeExp = detByEntity('smokegrenade_expired')
  const flashDet = detByEntity('flashbang_detonate')
  const heDet = detByEntity('hegrenade_detonate')
  const decoyDet = detByEntity('decoy_started')
  const fireStart = E('inferno_startburn')
  const fireExpByEnt = detByEntity('inferno_expire')
  const firstAfter = (rows: Row[] | undefined, t: number) => rows?.find(r => r.tick >= t - 2)

  function finishNade(n: RawNade): Nade | undefined {
    if (n.path.length === 0) return undefined
    const throwTick = n.path[0][0]
    const lastTick = n.path[n.path.length - 1][0]
    let detTick = lastTick, endTick = lastTick
    const lastP = n.path[n.path.length - 1]
    if (n.type === 'smoke') {
      const d = firstAfter(smokeDet.get(n.id), throwTick); if (d) detTick = d.tick
      const e = firstAfter(smokeExp.get(n.id), detTick); endTick = e ? e.tick : detTick + 20 * tickrate
    } else if (n.type === 'flash') {
      const d = firstAfter(flashDet.get(n.id), throwTick); if (d) detTick = endTick = d.tick
    } else if (n.type === 'he') {
      const d = firstAfter(heDet.get(n.id), throwTick); if (d) detTick = endTick = d.tick
    } else if (n.type === 'decoy') {
      const d = firstAfter(decoyDet.get(n.id), throwTick); if (d) detTick = d.tick; endTick = detTick + 15 * tickrate
    } else if (n.type === 'molotov') {
      const f = fireStart.find(r => r.tick >= lastTick - 4 && r.tick <= lastTick + 64 &&
        Math.hypot((r.x ?? lastP[1]) - lastP[1], (r.y ?? lastP[2]) - lastP[2]) < 400)
      if (f) {
        detTick = f.tick
        const e = firstAfter(fireExpByEnt.get(Number(f.entityid)), detTick)
        endTick = e ? e.tick : detTick + 7 * tickrate
      } else endTick = detTick // in Smoke gelandet oder verpufft
    }
    const path = n.path.filter(p => p[0] <= detTick)
    return {
      id: n.id, type: n.type, thrower: n.thrower, throwTick, detTick, endTick,
      path: path.length ? path : [n.path[0]], throwPlace: '', landPlace: '',
    }
  }
  const allNades = rawNades.map(finishNade).filter((n): n is Nade => !!n)

  // --- Zeilen nach Runde verteilen --------------------------------------
  const roundIdxOfTick = (t: number) => {
    let lo = 0, hi = bounds.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (t < bounds[mid].startTick) hi = mid - 1
      else if (t > (bounds[mid] as any).viewEnd) lo = mid + 1
      else return mid
    }
    return -1
  }

  const rounds: Round[] = bounds.map((b, i) => {
    const sides = sideAtRound.get(b.freezeEndTick) ?? new Map<string, Side>()
    const teamOnSide = { CT: '', T: '' } as Record<Side, string>
    for (const side of ['CT', 'T'] as Side[]) {
      const counts = new Map<string, number>()
      for (const [s, sd] of sides) if (sd === side) { const t = teamOfPlayer.get(s); if (t) counts.set(t, (counts.get(t) ?? 0) + 1) }
      teamOnSide[side] = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''
    }
    return {
      num: i + 1, startTick: b.startTick, freezeEndTick: b.freezeEndTick, endTick: b.endTick,
      winner: b.winner, reason: b.reason, teamOnSide,
      buy: { CT: 'full', T: 'full' }, equipValue: { CT: 0, T: 0 }, scoreBefore: { CT: 0, T: 0 },
      frameTicks: [], tracks: [], weapons: [], places: [], kills: [], damages: [], blinds: [], nades: [],
    }
  })

  // Frames
  const trackIdx = rounds.map(() => new Map<string, number>())
  const weaponIdx = rounds.map(() => new Map<string, number>())
  const placeIdx = rounds.map(() => new Map<string, number>())
  const intern = (m: Map<string, number>, arr: string[], v: string) => {
    let k = m.get(v); if (k === undefined) { k = arr.length; arr.push(v); m.set(v, k) } return k
  }
  for (let i = 0; i < ticks.n; i++) {
    const t = c.tick[i]; const ri = roundIdxOfTick(t); if (ri < 0) continue
    const s = sid(c.steamid[i]); const side = sideOf(c.team[i]); if (!s || !side) continue
    const R = rounds[ri]
    if (R.frameTicks[R.frameTicks.length - 1] !== t) {
      if (R.frameTicks.length && t < R.frameTicks[R.frameTicks.length - 1]) continue
      // Raster lückenlos halten (Tick ohne Zeilen, z. B. Freeze-Zeit): 3D-Spuren und Granaten rechnen mit festem FRAME_STEP
      while (R.frameTicks.length && t - R.frameTicks[R.frameTicks.length - 1] > FRAME_STEP) R.frameTicks.push(R.frameTicks[R.frameTicks.length - 1] + FRAME_STEP)
      R.frameTicks.push(t)
    }
    const f = R.frameTicks.length - 1
    let ti = trackIdx[ri].get(s)
    if (ti === undefined) {
      ti = R.tracks.length; trackIdx[ri].set(s, ti)
      R.tracks.push({ steamid: s, side, x: [], y: [], z: [], yaw: [], hp: [], armor: [], weapon: [], place: [], flash: [], money: [],
        defuser: false, helmet: false, equipValue: 0, inventory: [] })
    }
    const tr = R.tracks[ti]
    // Lücken (Spieler kurz nicht im Frame) mit letztem Wert füllen
    while (tr.x.length < f) {
      const L = tr.x.length - 1
      tr.x.push(tr.x[L] ?? 0); tr.y.push(tr.y[L] ?? 0); tr.z.push(tr.z[L] ?? 0); tr.yaw.push(tr.yaw[L] ?? 0)
      tr.hp.push(tr.hp[L] ?? 0); tr.armor.push(tr.armor[L] ?? 0); tr.weapon.push(tr.weapon[L] ?? 0)
      tr.place.push(tr.place[L] ?? 0); tr.flash.push(0); tr.money.push(tr.money[L] ?? 0)
    }
    if (tr.x.length > f) continue
    const alive = c.alive[i] !== false && (c.hp[i] ?? 0) > 0
    tr.x.push(r1(c.X[i] ?? 0)); tr.y.push(r1(c.Y[i] ?? 0)); tr.z.push(r1(c.Z[i] ?? 0))
    tr.yaw.push(Math.round(c.yaw[i] ?? 0)); tr.hp.push(alive ? c.hp[i] : 0); tr.armor.push(c.armor[i] ?? 0)
    tr.weapon.push(intern(weaponIdx[ri], R.weapons, String(c.weapon[i] ?? '')))
    tr.place.push(intern(placeIdx[ri], R.places, String(c.place[i] ?? '')))
    tr.flash.push(0); tr.money.push(c.money[i] ?? 0)
  }
  // Alle Tracks auf gleiche Länge bringen
  for (const R of rounds) for (const tr of R.tracks) {
    while (tr.x.length < R.frameTicks.length) {
      const L = tr.x.length - 1
      tr.x.push(tr.x[L] ?? 0); tr.y.push(tr.y[L] ?? 0); tr.z.push(tr.z[L] ?? 0); tr.yaw.push(tr.yaw[L] ?? 0)
      tr.hp.push(tr.hp[L] ?? 0); tr.armor.push(tr.armor[L] ?? 0); tr.weapon.push(tr.weapon[L] ?? 0)
      tr.place.push(tr.place[L] ?? 0); tr.flash.push(0); tr.money.push(tr.money[L] ?? 0)
    }
  }

  // Ausrüstung bei Freezetime-Ende
  for (let i = 0; i < fe.n; i++) {
    const ri = bounds.findIndex(b => b.freezeEndTick === feCol.tick[i]); if (ri < 0) continue
    const s = sid(feCol.steamid[i]); if (!s) continue
    const ti = trackIdx[ri].get(s); if (ti === undefined) continue
    const tr = rounds[ri].tracks[ti]
    tr.equipValue = feCol.equip[i] ?? 0
    tr.inventory = Array.isArray(feCol.inv[i]) ? feCol.inv[i].map(String) : []
    tr.defuser = !!feCol.defuser[i]; tr.helmet = !!feCol.helmet[i]
  }
  rounds.forEach((R, i) => {
    const halfStart = i === 0 || rounds[i - 1].teamOnSide.CT !== R.teamOnSide.CT
    for (const side of ['CT', 'T'] as Side[]) {
      R.equipValue[side] = R.tracks.filter(t => t.side === side).reduce((a, t) => a + t.equipValue, 0)
      R.buy[side] = classifyBuy(halfStart, R.equipValue[side])
    }
  })

  // Score
  const score = new Map<string, number>(teams.map(t => [t, 0]))
  for (const R of rounds) {
    R.scoreBefore = { CT: score.get(R.teamOnSide.CT) ?? 0, T: score.get(R.teamOnSide.T) ?? 0 }
    const w = R.teamOnSide[R.winner]; if (w) score.set(w, (score.get(w) ?? 0) + 1)
  }

  // --- Events pro Runde -------------------------------------------------
  const sideIn = (ri: number, s?: string) => (s ? rounds[ri].tracks.find(t => t.steamid === s)?.side : undefined)
  const pos = (r: Row, p: string): [number, number, number] => [r1(r[`${p}_X`] ?? 0), r1(r[`${p}_Y`] ?? 0), r1(r[`${p}_Z`] ?? 0)]

  for (const r of E('player_death')) {
    const ri = roundIdxOfTick(r.tick); if (ri < 0) continue
    const victim = sid(r.user_steamid); if (!victim) continue
    const attacker = sid(r.attacker_steamid)
    rounds[ri].kills.push({
      tick: r.tick, attacker: attacker !== victim ? attacker : undefined, victim,
      assister: sid(r.assister_steamid), flashAssist: !!r.assistedflash,
      weapon: String(r.weapon ?? ''), headshot: !!r.headshot, wallbang: (r.penetrated ?? 0) > 0,
      throughSmoke: !!r.thrusmoke, attackerBlind: !!r.attackerblind, noscope: !!r.noscope,
      attackerPos: attacker ? pos(r, 'attacker') : undefined, victimPos: pos(r, 'user'),
      victimPlace: String(r.user_last_place_name ?? ''), attackerPlace: r.attacker_last_place_name,
      traded: false, isTrade: false,
    })
  }
  // Trades
  const W = TRADE_WINDOW_S * tickrate
  rounds.forEach((R, ri) => {
    for (const k of R.kills) {
      if (!k.attacker) continue
      const vSide = sideIn(ri, k.victim)
      // Wurde der Killer danach von einem Teamkollegen des Opfers getötet?
      const revenge = R.kills.find(k2 => k2.tick > k.tick && k2.tick - k.tick <= W && k2.victim === k.attacker &&
        k2.attacker && sideIn(ri, k2.attacker) === vSide)
      if (revenge) { k.traded = true; revenge.isTrade = true }
    }
  })

  const hpLeft = rounds.map(() => new Map<string, number>())
  for (const r of E('player_hurt')) {
    const ri = roundIdxOfTick(r.tick); if (ri < 0) continue
    const victim = sid(r.user_steamid); if (!victim) continue
    const before = hpLeft[ri].get(victim) ?? 100
    const after = Math.max(0, r.health ?? before - (r.dmg_health ?? 0))
    hpLeft[ri].set(victim, after)
    const weapon = String(r.weapon ?? '')
    rounds[ri].damages.push({
      tick: r.tick, attacker: sid(r.attacker_steamid), victim, dmg: Math.max(0, Math.min(r.dmg_health ?? 0, before)), weapon,
      utility: /hegrenade|molotov|inferno|incgrenade/.test(weapon),
    })
  }

  for (const r of E('player_blind')) {
    const ri = roundIdxOfTick(r.tick); if (ri < 0) continue
    const victim = sid(r.user_steamid); const attacker = sid(r.attacker_steamid)
    if (!victim || !attacker || (r.blind_duration ?? 0) < 0.1) continue
    const team = attacker !== victim && sideIn(ri, attacker) === sideIn(ri, victim)
    rounds[ri].blinds.push({ tick: r.tick, attacker, victim, duration: r1(r.blind_duration), team })
  }

  const bomb = (name: string): (BombEvent & { ri: number })[] => E(name).flatMap(r => {
    const ri = roundIdxOfTick(r.tick)
    return ri < 0 ? [] : [{ ri, tick: r.tick, player: sid(r.user_steamid) ?? '', site: siteFromPlace(r.user_last_place_name), pos: pos(r, 'user') }]
  })
  for (const b of bomb('bomb_planted')) rounds[b.ri].plant = b
  for (const b of bomb('bomb_defused')) rounds[b.ri].defuse = b
  for (const r of E('bomb_exploded')) { const ri = roundIdxOfTick(r.tick); if (ri >= 0) rounds[ri].exploded = r.tick }

  // Granaten den Runden zuordnen, Wurf-/Landeort aus Spielerposition ableiten
  for (const n of allNades) {
    const ri = roundIdxOfTick(n.throwTick); if (ri < 0) continue
    const R = rounds[ri]
    const tr = R.tracks.find(t => t.steamid === n.thrower)
    if (tr) {
      const f = Math.max(0, Math.min(R.frameTicks.length - 1, Math.round((n.throwTick - R.frameTicks[0]) / FRAME_STEP)))
      n.throwPlace = R.places[tr.place[f]] ?? ''
    }
    R.nades.push(n)
  }
  for (const R of rounds) R.nades.sort((a, b) => a.throwTick - b.throwTick)

  const finalScore = Object.fromEntries(score)
  progress(95, 'Done')
  return {
    version: DATA_VERSION, id, fileName, map, parsedAt: new Date().toISOString(), tickrate,
    serverName: String(header.server_name ?? ''), players, teams, finalScore, rounds,
  }
}
