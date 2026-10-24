// HUD-Modell des 3D-Replays (Übertragungs-HUD, Entwurf v2): reine Funktionen aus v1 (MatchData) + CS3D + HudTrack, kein DOM.
// hudView ruft der Bildtakt höchstens 15×/s, timeline einmal je Fokus-Spieler. Indizes je Match/HudTrack in WeakMaps (lazy je Runde).
// Regeln (spike/ui/_results/plan.json P4 + daten.json): Bombe explodiert 41,0 s nach dem Legen; Defuse 5 s mit Kit, 10 s ohne,
// Abbruch nur über FLAG.defusing (kein Event); X VS Y ab dem ersten Tod; Captain = Spieler mit Namen = Teamname ohne 'team_';
// Slots CT 1–5 / T 6–10 nach user_id (HudTrack), sonst Match-Reihenfolge. Ohne HudTrack (alter Import): Inventar bei
// Freeze-Ende minus Würfe, Kaufzeit 20 s ab Freeze-Ende, Reserve null.
import { EV, FLAG, flashAt, upperBound, type CS3D } from '../../../shared/cs3d'
import { at, type Avatars, type HudRound, type HudTrack } from '../../../shared/hud'
import { FRAME_STEP, type Kill, type MatchData, type NadeType, type Round, type Side } from '../../../shared/model'
import type { Replay3DData } from '../contracts'
import { keysAt } from '../InputsOverlay'
import { weaponLabel } from '../../format'
import type { HudFocus, HudPanel, HudPlayerView, HudView, KillView, TimelineEvent } from './types'

const ROUND_S = 115 // Rundenzeit ab Freeze-Ende
const BOMB_S = 41 // Explosion 41,0 s nach bomb_planted (4/4 gemessen), nicht 40
const BUY_S = 20 // mp_buytime: Ersatz, wenn buytime_ended fehlt
const HURT_S = 1.5 // roter HP-Verlust im Panel
const FEED_S = 5 // Killfeed

/** item_def_idx → v1-Anzeigename (Schusswaffen, Granaten, C4); Messer fehlen bewusst */
const ITEM: Record<number, string> = {
  1: 'Desert Eagle', 2: 'Dual Berettas', 3: 'Five-SeveN', 4: 'Glock-18', 7: 'AK-47', 8: 'AUG', 9: 'AWP', 10: 'FAMAS', 11: 'G3SG1',
  13: 'Galil AR', 14: 'M249', 16: 'M4A4', 17: 'MAC-10', 19: 'P90', 23: 'MP5-SD', 24: 'UMP-45', 25: 'XM1014', 26: 'PP-Bizon', 27: 'MAG-7',
  28: 'Negev', 29: 'Sawed-Off', 30: 'Tec-9', 31: 'Zeus x27', 32: 'P2000', 33: 'MP7', 34: 'MP9', 35: 'Nova', 36: 'P250', 38: 'SCAR-20',
  39: 'SG 553', 40: 'SSG 08', 43: 'Flashbang', 44: 'High Explosive Grenade', 45: 'Smoke Grenade', 46: 'Molotov', 47: 'Decoy Grenade',
  48: 'Incendiary Grenade', 49: 'C4 Explosive', 60: 'M4A1-S', 61: 'USP-S', 63: 'CZ75-Auto', 64: 'R8 Revolver',
}
const DEF = new Map(Object.entries(ITEM).map(([k, v]) => [v, Number(k)]))
const PRIMARY = new Set([7, 8, 9, 10, 11, 13, 14, 16, 17, 19, 23, 24, 25, 26, 27, 28, 29, 33, 34, 35, 38, 39, 40, 60])
const PISTOL = new Set([1, 2, 3, 4, 30, 32, 36, 61, 63, 64])
/** Anzeige-Reihenfolge der Granaten (Entwurf v2) */
const NADES = ['Flashbang', 'Smoke Grenade', 'High Explosive Grenade', 'Molotov', 'Incendiary Grenade', 'Decoy Grenade']
const THROWN: Record<NadeType, string[]> = {
  smoke: ['Smoke Grenade'], flash: ['Flashbang'], he: ['High Explosive Grenade'], molotov: ['Molotov', 'Incendiary Grenade'], decoy: ['Decoy Grenade'],
}

/** Hauptwaffe: Primär > Pistole */
const main = (defs: readonly number[]) => ITEM[defs.find(d => PRIMARY.has(d)) ?? defs.find(d => PISTOL.has(d)) ?? 0] ?? ''
/** Granaten minus Würfe mit from < Wurf-Tick ≤ to, sortiert wie NADES */
function nadesLeft(names: readonly string[], throws: readonly [number, NadeType][], from: number, to: number): string[] {
  const left = names.filter(n => NADES.includes(n))
  for (const [t, type] of throws) if (t > from && t <= to) { const i = left.findIndex(n => THROWN[type].includes(n)); if (i >= 0) left.splice(i, 1) }
  return left.sort((a, b) => NADES.indexOf(a) - NADES.indexOf(b))
}

interface RoundIx {
  /** CS3D-Runde, −1 = keine 3D-Daten */
  r3: number
  /** steamid → Track-Index in der CS3D-Runde */
  k3: Map<string, number>
  side: Map<string, Side>
  /** Bombenträger-Wechsel [tick, steamid | null] */
  carrier: [number, string | null][]
  /** bomb_begindefuse [tick, steamid, Kit] */
  begin: [number, string, boolean][]
  throws: Map<string, [number, NadeType][]>
  /** zuletzt gehaltene Primärwaffe je v1-Frame (Ersatz ohne HudTrack): Frames aufsteigend + Namen */
  held: Map<string, { f: number[]; w: string[] }>
  /** Slots für diese Quelle (HudTrack oder null = Match-Reihenfolge) */
  slotSrc?: HudTrack | null
  slot?: Map<string, number>
}
interface MatchIx {
  d: CS3D
  starts: number[]
  rounds: (RoundIx | undefined)[]
  name: Map<string, string>
  order: Map<string, number>
  p3: Map<string, number>
  r3: Map<number, number>
  /** Kill-/Todes-Ticks je Spieler, aufsteigend (Kills ohne Selbstmord) */
  killT: Map<string, number[]>
  deathT: Map<string, number[]>
  captain: Map<string, string | null>
  timeline: Map<string, TimelineEvent[]>
}
interface TrackIx { rounds: Map<number, HudRound>; loss: Map<string, { t: number[]; v: number[] }> }

const MIX = new WeakMap<MatchData, MatchIx>()
const TIX = new WeakMap<HudTrack, TrackIx>()
const push = <T>(m: Map<string, T[]>, k: string, v: T) => { const a = m.get(k); if (a) a.push(v); else m.set(k, [v]) }

function matchIx(match: MatchData, d: CS3D): MatchIx {
  const old = MIX.get(match)
  if (old && old.d === d) return old
  const killT = new Map<string, number[]>(), deathT = new Map<string, number[]>()
  for (const R of match.rounds) for (const k of R.kills) {
    if (k.attacker && k.attacker !== k.victim) push(killT, k.attacker, k.tick)
    push(deathT, k.victim, k.tick)
  }
  for (const a of [...killT.values(), ...deathT.values()]) a.sort((p, q) => p - q)
  const X: MatchIx = {
    d, starts: match.rounds.map(R => R.startTick), rounds: [], killT, deathT, captain: new Map(), timeline: new Map(),
    name: new Map(match.players.map(p => [p.steamid, p.name])), order: new Map(match.players.map((p, i) => [p.steamid, i])),
    p3: new Map(d.header.players.map((p, i) => [p.steamid, i])), r3: new Map(d.header.rounds.map((r, i) => [r.num, i])),
  }
  MIX.set(match, X)
  return X
}

function roundIx(X: MatchIx, ri: number, R: Round): RoundIx {
  const old = X.rounds[ri]
  if (old) return old
  const d = X.d, E = d.evt, P = d.header.players, r3 = X.r3.get(R.num) ?? -1, R3 = d.header.rounds[r3]
  const k3 = new Map<string, number>()
  if (R3) for (const tr of R.tracks) { const k = R3.tracks.indexOf(X.p3.get(tr.steamid) ?? -1); if (k >= 0) k3.set(tr.steamid, k) }
  // Bombenträger: Inventar bei Freeze-Ende, danach bomb_pickup / bomb_dropped / bomb_planted
  const carrier: RoundIx['carrier'] = [[R.startTick, R.tracks.find(tr => tr.inventory.some(w => /c4/i.test(w)))?.steamid ?? null]]
  const begin: RoundIx['begin'] = []
  for (let e = upperBound(E.tick, R.freezeEndTick); e < E.tick.length && E.tick[e] <= R.endTick; e++) {
    const ty = E.type[e], sid = P[E.player[e]]?.steamid ?? null
    if (ty === EV.bomb_pickup) carrier.push([E.tick[e], sid])
    else if (ty === EV.bomb_dropped || ty === EV.bomb_planted) carrier.push([E.tick[e], null])
    else if (ty === EV.bomb_begindefuse && sid) begin.push([E.tick[e], sid, E.arg[e] === 1])
  }
  const throws = new Map<string, [number, NadeType][]>()
  for (const n of [...R.nades].sort((a, b) => a.throwTick - b.throwTick)) push(throws, n.thrower, [n.throwTick, n.type])
  const prim = R.weapons.map(w => PRIMARY.has(DEF.get(w) ?? 0))
  const held = new Map<string, { f: number[]; w: string[] }>()
  for (const tr of R.tracks) {
    const h = { f: [] as number[], w: [] as string[] }
    for (let j = 0; j < tr.weapon.length; j++) {
      const wi = tr.weapon[j]
      if (prim[wi] && R.weapons[wi] !== h.w[h.w.length - 1]) { h.f.push(j); h.w.push(R.weapons[wi]) }
    }
    held.set(tr.steamid, h)
  }
  return (X.rounds[ri] = { r3, k3, side: new Map(R.tracks.map(tr => [tr.steamid, tr.side])), carrier, begin, throws, held })
}

function trackIx(t: HudTrack, starts: number[]): TrackIx {
  const old = TIX.get(t)
  if (old) return old
  // HP-Verlust je Treffer = HP davor − health (dmg_health ist ungenau); HP startet jede Runde bei 100
  const loss = new Map<string, { t: number[]; v: number[] }>(), last = new Map<string, [round: number, hp: number]>()
  for (const h of t.hurt) {
    const r = upperBound(starts, h.tick) - 1, p = last.get(h.victim), before = p && p[0] === r ? p[1] : 100
    last.set(h.victim, [r, h.health])
    let L = loss.get(h.victim)
    if (!L) loss.set(h.victim, (L = { t: [], v: [] }))
    L.t.push(h.tick); L.v.push(Math.max(0, before - h.health))
  }
  const T: TrackIx = { rounds: new Map(t.rounds.map(r => [r.num, r])), loss }
  TIX.set(t, T)
  return T
}

/** Slots 1–5 (CT) / 6–10 (T): je Seite nach user_id aus dem HudTrack, sonst nach match.players */
function slots(X: MatchIx, RX: RoundIx, R: Round, track: HudTrack | null): Map<string, number> {
  if (RX.slot && RX.slotSrc === track) return RX.slot
  const key = (sid: string) => (track?.slots[sid] ?? 100) * 1000 + (X.order.get(sid) ?? 999)
  const slot = new Map<string, number>()
  for (const [side, first] of [['CT', 1], ['T', 6]] as const)
    R.tracks.filter(tr => tr.side === side).map(tr => tr.steamid).sort((a, b) => key(a) - key(b)).forEach((sid, i) => slot.set(sid, first + i))
  RX.slotSrc = track
  return (RX.slot = slot)
}

const count = (arr: number[] | undefined, from: number, to: number) => (arr ? upperBound(arr, to) - upperBound(arr, from) : 0)

/** Anzeige des Übertragungs-HUDs bei tick (gebrochen erlaubt). focus = Fokus-Spieler (Panel, eigener Kill), speaking = audio.speaking(tick). */
export function hudView(data: Replay3DData, track: HudTrack | null, tick: number, focus: string | null, speaking: readonly string[], avatars: Avatars): HudView {
  const { match, d } = data, X = matchIx(match, d), rate = match.tickrate || 64
  const ri = Math.max(0, upperBound(X.starts, tick) - 1), R = match.rounds[ri], RX = roundIx(X, ri, R)
  const TX = track ? trackIx(track, X.starts) : null, HR = TX?.rounds.get(R.num)
  const n = R.frameTicks.length, f = n ? Math.max(0, Math.min(n - 1, Math.floor((tick - R.frameTicks[0]) / FRAME_STEP))) : 0
  const R3 = d.header.rounds[RX.r3]
  /** CS3D-Index des Frames f für steamid, −1 = keine 3D-Spur (CS3D-Frame i = v1-Frame i) */
  const i3 = (sid: string) => {
    const k = RX.k3.get(sid)
    return k === undefined || !R3 ? -1 : d.frameBase[RX.r3] + k * R3.nFrames + Math.min(f, R3.nFrames - 1)
  }
  const t = Math.min(tick, R.endTick), planted = !!R.plant && t >= R.plant.tick
  const carrier = at(RX.carrier, tick)?.[1] ?? null
  const slot = slots(X, RX, R, track)

  const players: HudPlayerView[] = R.tracks.map(tr => {
    const sid = tr.steamid, hp = tr.hp[f] ?? 0, alive = hp > 0, armor = tr.armor[f] ?? 0, P = HR?.players[sid], p3 = X.p3.get(sid)
    const inv = P && at(P.inv, tick), throws = RX.throws.get(sid) ?? []
    let utility: string[], primary: string
    if (inv) {
      utility = nadesLeft(inv[1].map(def => ITEM[def] ?? ''), throws, inv[0], tick)
      primary = main(inv[1])
    } else {
      const h = RX.held.get(sid)!, j = upperBound(h.f, f) - 1
      utility = nadesLeft(tr.inventory, throws, -1, tick)
      primary = h.w[j] ?? main(tr.inventory.map(w => DEF.get(w) ?? 0))
    }
    return {
      slot: slot.get(sid) ?? 0, steamid: sid, name: X.name.get(sid) ?? sid, side: tr.side, alive, hp, armor,
      helmet: (P ? at(P.helmet, tick)?.[1] === 1 : tr.helmet) && armor > 0,
      kit: alive && (P ? at(P.kit, tick)?.[1] === 1 : tr.defuser), money: tr.money[f] ?? 0,
      kills: count(X.killT.get(sid), -1, tick), deaths: count(X.deathT.get(sid), -1, tick),
      roundKills: count(X.killT.get(sid), R.startTick - 1, tick),
      weapon: alive ? R.weapons[tr.weapon[f]] ?? '' : '', primary, utility: alive ? utility : [],
      bomb: alive && carrier === sid, speaking: speaking.includes(sid),
      flash: alive && p3 !== undefined ? flashAt(d, p3, tick) : 0, avatar: avatars[sid] ?? null,
    }
  }).sort((a, b) => a.slot - b.slot)

  // Defuse: letztes bomb_begindefuse, solange der Spieler FLAG.defusing hat (Abbruch hat kein Event)
  let defuse: HudView['defuse']
  const bd = planted ? at(RX.begin, tick) : undefined, bi = bd ? i3(bd[1]) : -1
  if (bd && bi >= 0 && d.flags[bi] & FLAG.defusing) {
    const dur = bd[2] ? 5 : 10, el = (tick - bd[0]) / rate
    defuse = { steamid: bd[1], kit: bd[2], progress: Math.min(1, Math.max(0, el / dur)), left: Math.max(0, dur - el) }
  }
  const bombAt = Math.min(t, R.defuse?.tick ?? Infinity, R.exploded ?? Infinity)
  const left = planted ? Math.max(0, BOMB_S - (bombAt - R.plant!.tick) / rate) : 0
  const score = { ...R.scoreBefore }
  if (tick >= R.endTick) score[R.winner]++
  const alive = (s: Side) => players.filter(p => p.side === s && p.alive).length

  const killfeed = R.kills.filter(k => k.tick <= tick && tick - k.tick <= FEED_S * rate).map((k: Kill): KillView => ({
    tick: k.tick, attacker: k.attacker ? X.name.get(k.attacker) ?? '' : '', attackerSide: k.attacker ? RX.side.get(k.attacker) : undefined,
    victim: X.name.get(k.victim) ?? '', victimSide: RX.side.get(k.victim) ?? 'CT',
    assister: k.assister ? X.name.get(k.assister) : undefined, assisterSide: k.assister ? RX.side.get(k.assister) : undefined,
    flashAssist: k.flashAssist, weapon: k.weapon, hs: k.headshot, wallbang: k.wallbang, smoke: k.throughSmoke, blind: k.attackerBlind,
    noscope: k.noscope, ago: (tick - k.tick) / rate, own: !!focus && k.attacker === focus,
  }))

  let panel: HudPanel | null = null, fo: HudFocus | undefined
  const fp = focus ? players.find(p => p.steamid === focus) : undefined
  if (fp) {
    const i = i3(fp.steamid), P = HR?.players[fp.steamid], def = i >= 0 ? d.weapon[i] : DEF.get(fp.weapon) ?? 0
    const gun = fp.alive && (PRIMARY.has(def) || PISTOL.has(def) || def === 31)
    let reserve: number | null = null
    for (let j = (P?.reserve.length ?? 0) - 1; gun && j >= 0; j--) { const e = P!.reserve[j]; if (e[0] <= tick && e[1] === def) { reserve = e[2]; break } }
    let lost = 0
    const L = TX?.loss.get(fp.steamid)
    if (L) for (let j = upperBound(L.t, tick) - 1; j >= 0 && L.t[j] > tick - HURT_S * rate && L.t[j] >= R.startTick; j--) lost += L.v[j]
    else if (!TX) { const tr = R.tracks.find(x => x.steamid === fp.steamid)!; lost = Math.max(0, (tr.hp[Math.max(0, f - Math.round(HURT_S * rate / FRAME_STEP))] ?? 0) - fp.hp) }
    const buyEnd = HR && HR.buyEndTick >= 0 ? HR.buyEndTick : R.freezeEndTick + BUY_S * rate
    panel = {
      steamid: fp.steamid, hp: fp.hp, hpLost: Math.min(lost, 100 - fp.hp), mag: gun && i >= 0 ? d.ammo[i] : null, reserve,
      weapon: fp.weapon, buy: fp.alive && tick >= R.startTick && tick < buyEnd && (P ? at(P.buyzone, tick)?.[1] === 1 : true),
      money: fp.money, voice: fp.speaking,
    }
    const p3 = X.p3.get(fp.steamid)
    if (i >= 0 && p3 !== undefined) fo = { steamid: fp.steamid, keys: keysAt(d, fp.steamid, tick), scoped: !!(d.flags[i] & FLAG.scoped), fov: d.fov[i] || 90, flash: flashAt(d, p3, tick) }
  }

  return {
    tick, round: R.num, score, phase: tick < R.freezeEndTick ? 'freeze' : tick >= R.endTick ? 'over' : planted ? 'planted' : 'live',
    teams: { CT: { name: R.teamOnSide.CT, captain: captain(X, R.teamOnSide.CT, avatars) }, T: { name: R.teamOnSide.T, captain: captain(X, R.teamOnSide.T, avatars) } },
    clock: t < R.freezeEndTick ? (R.freezeEndTick - t) / rate : planted ? left : Math.max(0, ROUND_S - (t - R.freezeEndTick) / rate),
    bomb: { planted, site: planted ? R.plant!.site : undefined, left, total: planted ? BOMB_S : 0 },
    defuse, vs: players.some(p => !p.alive) ? { ct: alive('CT'), t: alive('T') } : undefined,
    players, panel, killfeed, focus: fo,
  }
}

/** Captain = Spieler, dessen Name dem Teamnamen ohne 'team_' gleicht (Groß/Klein egal); null → Initialen */
function captain(X: MatchIx, team: string, avatars: Avatars) {
  let sid = X.captain.get(team)
  if (sid === undefined) {
    const want = team.replace(/^team_/i, '').toLowerCase()
    sid = [...X.name].find(([, nm]) => nm.toLowerCase() === want)?.[0] ?? null
    X.captain.set(team, sid)
  }
  return sid ? { steamid: sid, name: X.name.get(sid) ?? sid, avatar: avatars[sid] ?? null } : null
}

/** Zeitleiste der Demo-Leiste über alle Runden: Kill/Tod aus Sicht von focus, Bombe gelegt/entschärft/explodiert; je Fokus gemerkt */
export function timeline(match: MatchData, d: CS3D, focus: string | null): TimelineEvent[] {
  const X = matchIx(match, d), memo = X.timeline.get(focus ?? '')
  if (memo) return memo
  const nm = (s?: string) => (s && X.name.get(s)) || 'World'
  const ev: TimelineEvent[] = []
  for (const R of match.rounds) {
    for (const k of R.kills) {
      if (!focus) break
      if (k.attacker === focus && k.victim !== focus) ev.push({ tick: k.tick, round: R.num, kind: 'kill', text: `${nm(focus)} killed ${nm(k.victim)} (${weaponLabel(k.weapon)})` })
      else if (k.victim === focus) ev.push({ tick: k.tick, round: R.num, kind: 'death', text: k.attacker && k.attacker !== focus ? `${nm(focus)} killed by ${nm(k.attacker)} (${weaponLabel(k.weapon)})` : `${nm(focus)} died` })
    }
    if (R.plant) ev.push({ tick: R.plant.tick, round: R.num, kind: 'plant', text: `Bomb planted${R.plant.site ? ` at ${R.plant.site}` : ''} by ${nm(R.plant.player)}` })
    if (R.defuse) ev.push({ tick: R.defuse.tick, round: R.num, kind: 'defuse', text: `Bomb defused by ${nm(R.defuse.player)}` })
    if (R.exploded) ev.push({ tick: R.exploded, round: R.num, kind: 'explode', text: 'Bomb exploded' })
  }
  ev.sort((a, b) => a.tick - b.tick)
  X.timeline.set(focus ?? '', ev)
  return ev
}
