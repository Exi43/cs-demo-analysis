// Baut die 3D-Replay-Daten (CS3D v7, shared/cs3d.ts) aus der Demo. Läuft im Parser-Prozess nach parseDemo:
//   const buf = readDemoBuffer(readFileSync(file)); const m = parseDemo(buf, …)   (Demo nur einmal entpacken)
//   writeFileSync(join(outDir, `${m.id}.3d.bin.gz`), gzipSync(encode3d(parse3d(buf, m))))
// Runden, Frames, Spieler, Positionen und HP kommen aus MatchData (CS3D-Frame i = v1-Frame i, Track k = v1-Track k).
// Hier nur, was 3D zusätzlich braucht: 1× parseTicks 16 Hz (Props unten, inkl. Skin der aktiven Waffe), 1× parseTicks 1 s nach
// jedem Freeze-Ende (Crosshair, Viewmodel, Messer, Handschuhe), 1× parseTicks pitch/yaw/Punch auf den Zwischen-Ticks (→ 32 Hz Winkel),
// 1× parseEvents (Events, fire_bullets, Detonationen), Voice + Server-Sounds (GE_SosStartSoundEvent: Schritte, Landungen, Aufprall
// liegender Waffen) im selben Durchlauf, daraus liegende Waffen (dropsOf).
// Gemessen user-demo (291 MB, 21 Runden): +9.2 s (16 Hz 4.7 inkl. Inventar 1.0 + Einstellungen 0.3 + Winkel 2.5 + Events 0.5 + Voice/Sounds/
// Waffen 1.0, Aufkleber/Anhänger aus den FullPackets 0.3 = econ.ts) + encode/gzip 0.4 s → 1.84 MB gz (556 liegende Waffen, 18 069 Server-Sounds: +28 KB), RSS ≈ 1.45 GB (Test-maxRSS).
// Test: node --max-old-space-size=4096 scripts/dev3d/parse3d-test.ts, liegende Waffen: scripts/dev3d/drops-check.ts
import * as dp from '@laihoe/demoparser2'
import type { MatchData } from '../shared/model.ts'
import {
  EV, FLAG, NADE, soundHash, splitButtons, type CS3DInput, type Drop3D, type Event3D, type Nade3D, type Player3D, type Round3DIn, type Shot3D,
  type Skin3D, type Sound3D,
} from '../shared/cs3d.ts'
import { decodeCrosshair } from '../shared/crosshair.ts'
import { readDemoBuffer } from './parse.ts'
import { econAttributes, econOf } from './econ.ts'
import { extractVoice, proto, unsnappy } from './voice.ts'

type Row = Record<string, any>
type Progress = (pct: number, msg: string) => void

const FOV = 'CCSPlayerPawn.CCSPlayer_CameraServices.m_iFOV'
const AGENT = 'CCSPlayerController.m_nPawnCharacterDefIndex'
// Skin-Props gelten für die aktive Waffe (Entity, nicht Spieler); Qualität 9 = StatTrak. Item-ID/Fallback: siehe skinOf (+0,2 s user-demo)
const PROPS = ['pitch', 'yaw', 'duck_amount', 'is_scoped', 'is_walking', 'is_airborne', 'is_defusing', 'spotted', 'item_def_idx',
  FOV, 'Weapon.m_bSilencerOn', 'is_in_reload', 'active_weapon_ammo', 'Weapon.m_bStartedArming', 'usercmd_buttonstate_1', AGENT,
  'CCSPlayerPawn.m_bLeftHanded', 'weapon_skin_id', 'weapon_paint_seed', 'weapon_float', 'custom_name', 'Weapon.m_iEntityQuality',
  'Weapon.m_iItemIDLow', 'Weapon.m_iItemIDHigh', 'Weapon.m_nFallbackPaintKit', 'Weapon.m_nFallbackSeed', 'Weapon.m_flFallbackWear',
  // liegende Waffen (dropsOf): Inventar-Diff + Entschärfer-Set (+1,1 s user-demo)
  'inventory_as_ids', 'has_defuser']
const VM = ['CCSPlayerPawn.m_flViewmodelFOV', 'CCSPlayerPawn.m_flViewmodelOffsetX', 'CCSPlayerPawn.m_flViewmodelOffsetY', 'CCSPlayerPawn.m_flViewmodelOffsetZ']
/** Einstellungen/Inventar: ändern sich selten → nur 1 s nach Freeze-Ende jeder Runde statt 16 Hz */
const SETTINGS = ['crosshair_code', ...VM, 'inventory_as_ids', 'glove_item_idx', 'glove_paint_id', 'glove_paint_seed', 'glove_paint_float']
const AIM = 'CCSPlayerPawn.CCSPlayer_AimPunchServices.m_predictableBase', VPU = 'CCSPlayerPawn.CCSPlayer_CameraServices.m_'
/** Rückstoß (32 Hz wie pitch/yaw): Basiswert + Zeitpunkt, m_nTickBase = Server-Tick jetzt */
const PUNCH = [AIM + 'Angle', AIM + 'AngleVel', AIM + 'Tick', AIM + 'TickInterpAmount',
  VPU + 'vecCsViewPunchAngle', VPU + 'nCsViewPunchAngleTick', VPU + 'flCsViewPunchAngleTickRatio', 'CCSPlayerController.m_nTickBase']
const isKnife = (d: number) => d === 42 || d === 59 || (d >= 500 && d < 600)
// demoparser2 liefert für unbekannte Props keine Spalte und keinen Fehler → ohne diese wäre die 3D-Datei wertlos
const REQUIRED = ['pitch', 'yaw', 'duck_amount', 'item_def_idx']
/** Detonations-Event je v1-Granatentyp (x/y/z = Wirkungsort) */
const DET: Record<string, string> = {
  smoke: 'smokegrenade_detonate', flash: 'flashbang_detonate', he: 'hegrenade_detonate', decoy: 'decoy_started', molotov: 'inferno_startburn',
}

const sid = (v: any): string | undefined => (v == null || v === '' || v === '0' || v === 0 ? undefined : String(v))
const nanArr = (n: number) => new Array<number>(n).fill(NaN)
/** Lücken (Spieler ohne Zeile) mit Vorwert füllen, führende mit dem ersten Wert */
function fill(a: number[]) {
  let v = a.find(x => x === x) ?? 0
  for (let i = 0; i < a.length; i++) if (a[i] !== a[i]) a[i] = v; else v = a[i]
}

/**
 * Aim-/View-Punch (Grad) bei Zeile i; c = Spalten in PUNCH-Reihenfolge. Die Demo hat nur Basiswerte vom letzten Schuss/Landen,
 * der Client klingt sie ab. Tick-Felder zählen halbe Server-Ticks (Zeit = Feld/2 + Bruchteil).
 * Aim: CS:GO DecayAimPunchAngle (weapon_recoil_decay2_exp 8, decay2_lin 18, vel_decay 4.5) fein integriert; user-demo Exi-Spray:
 * nächster Basiswert auf ≤0.03° getroffen, Geschwindigkeit exakt. View: exp(−18 t) wie CS:GO view_punch_decay
 * (shortcut: Konstante in CS2 client.dll vorhanden, Wert nicht gemessen; bei sichtbar falschem Nachschwingen gegen CS2-Video prüfen).
 */
export function punchAt(c: any[][], i: number, rate: number): [number, number, number, number] {
  const now = c[7][i], H = 1 / 640, E = Math.exp(-8 * H), KV = Math.exp(-4.5 * H)
  let [p, y] = c[0][i] ?? [0, 0], [vp, vy] = c[1][i] ?? [0, 0]
  const ta = (now - c[2][i] / 2 - c[3][i]) / rate
  if (!(ta < 1)) p = y = 0 // nach 1 s ist alles abgeklungen (auch unbekannt = 0)
  else for (let t = Math.max(0, ta); t > 0; t -= H) {
    p *= E; y *= E
    const m = Math.hypot(p, y), k = m > 18 * H ? 1 - (18 * H) / m : 0
    p = p * k + vp * H / 2; y = y * k + vy * H / 2
    vp *= KV; vy *= KV
    p += vp * H / 2; y += vy * H / 2
  }
  const [vpp, vpy] = c[4][i] ?? [0, 0], f = Math.exp(-18 * Math.max(0, (now - c[5][i] / 2 - c[6][i]) / rate)) || 0
  return [p, y, vpp * f, vpy * f]
}

export function parse3d(raw: Buffer, m: MatchData, progress: Progress = () => {}): CS3DInput {
  const buf = readDemoBuffer(raw)
  const V1 = m.rounds.filter(R => R.frameTicks.length)

  const players: Player3D[] = m.players.map(p => ({ ...p, agent: { T: 0, CT: 0 } }))
  const pIdx = new Map(players.map((p, i) => [p.steamid, i]))
  const player = (s: string) => {
    let i = pIdx.get(s)
    if (i === undefined) { i = players.length; players.push({ steamid: s, name: s, team: '', agent: { T: 0, CT: 0 } }); pIdx.set(s, i) }
    return i
  }

  // Tick → [Runde, Winkel-Index j]; Frame = j/2. Über v1-frameTicks statt Arithmetik: bleibt bei fehlenden Demo-Ticks v1-gleich.
  const at = new Map<number, [number, number]>()
  const trk = V1.map(() => new Map<string, number>())
  const rounds: Round3DIn[] = V1.map((R, r) => {
    const n = R.frameTicks.length
    R.frameTicks.forEach((t, i) => { at.set(t, [r, 2 * i]); if (i + 1 < n) at.set(t + 2, [r, 2 * i + 1]) })
    return {
      num: R.num, firstTick: R.frameTicks[0], nFrames: n,
      tracks: R.tracks.map((t, k) => {
        trk[r].set(t.steamid, k)
        return {
          player: player(t.steamid), x: t.x, y: t.y, z: t.z,
          duck: nanArr(n), btnLo: nanArr(n), btnHi: nanArr(n), flags: nanArr(n), weapon: nanArr(n), fov: nanArr(n), ammo: nanArr(n), skin: nanArr(n),
          pitch: nanArr(2 * n - 1), yaw: nanArr(2 * n - 1), aimP: nanArr(2 * n - 1), aimY: nanArr(2 * n - 1), viewP: nanArr(2 * n - 1), viewY: nanArr(2 * n - 1),
        }
      }),
    }
  })
  const roundOf = (t: number) => V1.findIndex(R => t >= R.frameTicks[0] && t <= R.frameTicks[R.frameTicks.length - 1])

  // --- 16 Hz: alle Kanäle ------------------------------------------------
  progress(5, 'Reading 3D movement')
  const c = dp.parseTicks(buf, [...PROPS, ...PUNCH], V1.flatMap(R => R.frameTicks), null, true) as Row
  for (const k of REQUIRED) if (!c[k]) throw new Error(`3D: demo has no '${k}' column`)
  const col = (k: string) => c[k] ?? []
  const [tick, steam, pitch, yaw, duck, scoped, walking, airborne, defusing, spotted, def, fov, silencer, reload, ammo, arming, btn, agent,
    left, paint, seed, wear, ntag, quality, idLo, idHi, fbPaint, fbSeed, fbWear, inventory, kit] = ['tick', 'steamid', ...PROPS].map(col)
  const invs = rounds.map(R => R.tracks.map(() => new Array<number[] | undefined>(R.nFrames))) // Inventar je Frame (dropsOf)
  const pc = PUNCH.map(col)
  const skins: Skin3D[] = [], skinIdx = new Map<string, number>()
  // Aufkleber/Anhänger je Item-ID ("hi:lo") aus den FullPackets (econ.ts, user-demo +0,3 s); Fehler → ohne
  const econ = new Map<string, NonNullable<ReturnType<typeof econOf>>>()
  try { for (const [k, v] of econAttributes(buf, unsnappy)) { const e = econOf(v); if (e) econ.set(k, e) } } catch (e) { console.warn('3D econ:', e) }
  /**
   * Skin-Index (1-basiert) der aktiven Waffe, 0 = Vanilla. Standardwaffen (Item-ID 0) liefern in demoparser2 die Lackierung einer früheren
   * Waffe am selben Entity-Index (demo-econ P0: 4,5–14,2 % der Skin-Frames) → Skin nur mit Item-ID ≠ 0, oder mit Fallback-Paint
   * (Community-Server-Plugins), dann deren Werte. Item-ID im Schlüssel: gleiche Lackierung zweier Items bleibt getrennt.
   */
  const skinOf = (i: number, d: number) => {
    const fb = fbPaint[i] > 0, item = idLo[i] || idHi[i] ? `${idHi[i] >>> 0}:${idLo[i] >>> 0}` : ''
    const p = fb ? fbPaint[i] : item ? paint[i] : 0, ec = item ? econ.get(item) : undefined
    if (!(p > 0) && !ec) return 0
    const sd = fb ? fbSeed[i] : seed[i], w = fb ? fbWear[i] : wear[i], painted = p > 0
    const key = `${item}|${d}|${p}|${sd}|${w}|${ntag[i] ?? ''}|${quality[i]}`
    let s = skinIdx.get(key)
    if (s === undefined) {
      // Vanilla mit Aufklebern/Anhänger: paint 0 (Seed/Wear der Demo gehören dann zu keiner Lackierung)
      skins.push({
        def: d, paint: painted ? p : 0, seed: painted ? Math.floor(sd ?? 0) : 0, wear: painted ? w ?? 0 : 0,
        ...(ntag[i] && { name: ntag[i] }), ...(quality[i] === 9 && { stattrak: true as const }), ...ec,
      })
      skinIdx.set(key, (s = skins.length))
    }
    return s
  }
  for (let i = 0; i < tick.length; i++) {
    const a = at.get(tick[i]); const s = sid(steam[i]); if (!a || !s || a[1] & 1) continue
    const [r, j] = a, k = trk[r].get(s); if (k === undefined) continue
    const T = rounds[r].tracks[k], f = j / 2
    T.pitch[j] = pitch[i] ?? NaN; T.yaw[j] = yaw[i] ?? NaN
    ;[T.aimP[j], T.aimY[j], T.viewP[j], T.viewY[j]] = punchAt(pc, i, m.tickrate)
    T.duck[f] = duck[i] ?? 0
    ;[T.btnLo[f], T.btnHi[f]] = splitButtons(btn[i])
    const d = def[i] ?? 0
    T.flags[f] = (scoped[i] ? FLAG.scoped : 0) | (walking[i] ? FLAG.walking : 0) | (airborne[i] ? FLAG.airborne : 0) |
      (defusing[i] ? FLAG.defusing : 0) | (spotted[i] ? FLAG.spotted : 0) | (silencer[i] ? FLAG.silencer : 0) |
      (reload[i] ? FLAG.reloading : 0) | (d === 49 && arming[i] ? FLAG.planting : 0) | (left[i] ? FLAG.lefthand : 0) | (kit[i] ? FLAG.defuser : 0)
    T.weapon[f] = d; T.fov[f] = fov[i] ?? 0; T.ammo[f] = ammo[i] ?? 0
    invs[r][k][f] = inventory[i] ?? undefined
    T.skin[f] = d ? skinOf(i, d) : 0
    // Agent pro Seite: erster Wert ≥ 1 s nach Freeze-Ende (agents-Spike), wechselt zur Halbzeit
    const side = V1[r].tracks[k].side, P = players[T.player]
    if (!P.agent[side] && agent[i] > 0 && tick[i] >= V1[r].freezeEndTick + 64) P.agent[side] = agent[i]
  }

  // --- Crosshair, Viewmodel, Messer, Handschuhe: 1 s nach Freeze-Ende (wie Agent) ---
  progress(35, 'Reading player settings')
  const feRound = new Map(V1.map((R, r) => [R.freezeEndTick + 64, r]))
  for (const row of dp.parseTicks(buf, SETTINGS, [...feRound.keys()]) as Row[]) {
    const r = feRound.get(row.tick), s = sid(row.steamid), k = r === undefined || !s ? undefined : trk[r].get(s)
    if (k === undefined) continue
    const P = players[rounds[r!].tracks[k].player], side = V1[r!].tracks[k].side
    // Ticks aufsteigend → letzter gültiger Crosshair/Viewmodel gewinnt; Messer/Handschuh wie Agent: erster Wert pro Seite
    const xc = typeof row.crosshair_code === 'string' ? decodeCrosshair(row.crosshair_code) : null
    if (xc) P.crosshair = xc
    if (row[VM[0]] > 0) P.vm = { fov: row[VM[0]], x: row[VM[1]] ?? 0, y: row[VM[2]] ?? 0, z: row[VM[3]] ?? 0 }
    const knife = (row.inventory_as_ids as number[] | undefined)?.find(isKnife)
    if (knife) (P.knife ??= {})[side] ??= knife
    if (row.glove_item_idx > 0) (P.glove ??= {})[side] ??= {
      def: row.glove_item_idx, paint: row.glove_paint_id ?? 0, seed: Math.floor(row.glove_paint_seed ?? 0), wear: row.glove_paint_float ?? 0,
    }
  }

  // --- Winkel auf den Zwischen-Ticks → 32 Hz ------------------------------
  progress(40, 'Reading 3D view angles')
  const off = dp.parseTicks(buf, ['pitch', 'yaw', ...PUNCH], V1.flatMap(R => R.frameTicks.slice(0, -1).map(t => t + 2)), null, true) as Row
  const po = PUNCH.map(k => off[k] ?? [])
  for (let i = 0; i < (off.tick?.length ?? 0); i++) {
    const a = at.get(off.tick[i]); const s = sid(off.steamid[i]); if (!a || !s || !(a[1] & 1)) continue
    const k = trk[a[0]].get(s); if (k === undefined) continue
    const T = rounds[a[0]].tracks[k]
    T.pitch[a[1]] = off.pitch[i] ?? NaN; T.yaw[a[1]] = off.yaw[i] ?? NaN
    ;[T.aimP[a[1]], T.aimY[a[1]], T.viewP[a[1]], T.viewY[a[1]]] = punchAt(po, i, m.tickrate)
  }
  rounds.forEach((R, r) => R.tracks.forEach((T, k) => {
    for (const ch of [T.duck, T.btnLo, T.btnHi, T.flags, T.weapon, T.fov, T.ammo, T.skin, T.pitch, T.yaw, T.aimP, T.aimY, T.viewP, T.viewY]) fill(ch)
    const hp = V1[r].tracks[k].hp
    for (let f = 0; f < R.nFrames; f++) if (hp[f] > 0) T.flags[f] |= FLAG.alive
  }))

  // --- Events (alle EV-Arten, auch player_footstep = Absprung/harte Landung, arg 0), Schüsse, Detonationen ---
  progress(65, 'Reading 3D events')
  const evRes = dp.parseEvents(buf, [...Object.keys(EV), 'fire_bullets', ...Object.values(DET)], [], [])
  const rows: Row[] = (Array.isArray(evRes) ? evRes : Object.values(evRes ?? {}).flat() as Row[]).filter(e => roundOf(e.tick) >= 0)
  const pOf = (v: any) => pIdx.get(sid(v) ?? '') ?? 255
  const silenced = new Set<string>()
  const incFire = new Map<string, { tick: number; inc: boolean }[]>() // Werfer → Molotov-/Brandgranaten-Würfe
  const det = new Map<string, Row[]>() // `${event}|${tick}` → Detonationen
  for (const e of rows) {
    if (e.event_name === 'weapon_fire') {
      if (e.silenced) silenced.add(`${e.tick}|${e.user_steamid}`)
      if (/molotov|incgrenade/.test(e.weapon)) {
        const s = String(e.user_steamid); (incFire.get(s) ?? incFire.set(s, []).get(s)!).push({ tick: e.tick, inc: /incgrenade/.test(e.weapon) })
      }
    }
    if (Object.values(DET).includes(e.event_name)) { const key = `${e.event_name}|${e.tick}`; (det.get(key) ?? det.set(key, []).get(key)!).push(e) }
  }

  const events: Event3D[] = [], shots: Shot3D[] = []
  for (const e of rows) {
    const name: string = e.event_name, p = pOf(e.user_steamid)
    if (name === 'fire_bullets') {
      if (e.origin_x == null || e.angles_x == null) continue
      shots.push({
        tick: e.tick, player: p, weapon: e.item_def_index ?? 0, silenced: silenced.has(`${e.tick}|${e.user_steamid}`),
        x: e.origin_x, y: e.origin_y, z: e.origin_z, pitch: e.angles_x, yaw: e.angles_y, recoil: e.recoil_index ?? 0,
      })
      continue
    }
    const type = (EV as Record<string, number>)[name]; if (type === undefined) continue
    const arg = name === 'weapon_fire' ? String(e.weapon ?? '')
      : name === 'item_pickup' ? String(e.item ?? '')
      : name === 'player_blind' ? Math.round((e.blind_duration ?? 0) * 100)
      : name === 'player_hurt' ? Math.min(255, e.dmg_health ?? 0) | (e.hitgroup === 'head' ? 256 : 0) | (e.armor > 0 ? 512 : 0)
      : name === 'player_death' ? pOf(e.attacker_steamid) | (e.headshot ? 256 : 0)
      : name === 'bomb_begindefuse' ? (e.haskit ? 1 : 0)
      : 0
    events.push({ tick: e.tick, type, player: p, arg })
  }

  // --- Granaten aus v1 (+ Wirkungsort, Molotov vs. Brandgranate, Critic P1-9) ---
  const nades: Nade3D[] = []
  for (const R of V1) for (const n of R.nades) {
    const last = n.path[n.path.length - 1]
    // nächste Detonation desselben Typs am detTick, sonst letzter Flugpunkt (Molly in Smoke verpufft)
    const hit = (det.get(`${DET[n.type]}|${n.detTick}`) ?? []).map(e => [Math.hypot(e.x - last[1], e.y - last[2], e.z - last[3]), e] as const)
      .filter(([dist]) => dist < 400).sort((a, b) => a[0] - b[0])[0]?.[1]
    let type: number = NADE[n.type]
    if (n.type === 'molotov') {
      // letzter Wurf des Werfers bis kurz nach dem Projektil-Start; ohne Treffer nach Seite (CT kauft Brandgranaten)
      const fire = (incFire.get(n.thrower) ?? []).filter(f => f.tick <= n.throwTick + 8).pop()
      type = (fire ? fire.inc : R.tracks.find(t => t.steamid === n.thrower)?.side === 'CT') ? NADE.incgrenade : NADE.molotov
    }
    nades.push({
      type, player: pOf(n.thrower), throwTick: n.throwTick, detTick: n.detTick, endTick: n.endTick,
      x: hit?.x ?? last[1], y: hit?.y ?? last[2], z: hit?.z ?? last[3], path: n.path,
    })
  }

  // --- Voice + Server-Sounds (ein Durchlauf) ---------------------------------
  progress(85, 'Reading voice')
  // auch zwischen den Runden (≈ 30 % der Sprache), nur Warmup/Ende weg
  const vFirst = V1[0]?.frameTicks[0] ?? Infinity, vLast = V1.at(-1)?.frameTicks.at(-1) ?? -Infinity
  const sos: Sos[] = []
  const voice = extractVoice(buf, (t, msg) => { if (t >= vFirst && t <= vLast) { const s = sosOf(t, msg); if (s) sos.push(s) } })
    .filter(v => v.tick >= vFirst && v.tick <= vLast)

  // --- Liegende Waffen + Schritte/Landungen der Spieler aus den Server-Sounds ---
  const sounds: Sound3D[] = []
  const impacts: Sos[] = []
  for (const s of sos) {
    if (IMPACT.has(s.hash)) { impacts.push(s); continue }
    if (!s.ent) continue
    const p = nearestPlayer(V1, s), pl = p === undefined ? undefined : pIdx.get(p)
    if (pl !== undefined) sounds.push({ tick: s.tick, hash: s.hash, player: pl })
  }
  const drops = dropsOf(V1, rounds, invs, rows, impacts, pIdx, m.tickrate)

  progress(100, '3D data ready')
  return { matchId: m.id, map: m.map, tickrate: m.tickrate, players, skins, rounds, events, shots, nades, voice, drops, sounds }
}

// ---------------------------------------------------------------- Server-Sounds (GE_SosStartSoundEvent)

interface Sos { tick: number; hash: number; ent: number; x: number; y: number; z: number }
/** Hash des Parameters public.position (Bytes 4d ce 7c 5a in packed_params) */
const POS_PARAM = 0x5a7cce4d
/**
 * CMsgSosStartSoundEvent: 2 = soundevent_hash (fixed32), 3 = source_entity_index, 5 = packed_params = je Parameter
 * [u32 Hash][u8 Typ][u16 Länge][Wert]; Ort = public.position (3 float). Ohne Ort: null.
 */
function sosOf(tick: number, msg: Uint8Array): Sos | null {
  const f = proto(msg), h = f[2]?.[0], pp = f[5]?.[0]
  if (!(h instanceof Uint8Array) || !(pp instanceof Uint8Array)) return null
  const dv = new DataView(pp.buffer, pp.byteOffset, pp.byteLength)
  for (let o = 0; o + 7 <= pp.length;) {
    const id = dv.getUint32(o, true), len = dv.getUint16(o + 5, true)
    if (id === POS_PARAM && len === 12 && o + 19 <= pp.length) {
      return { tick, hash: new DataView(h.buffer, h.byteOffset, 4).getUint32(0, true), ent: Number(f[3]?.[0] ?? 0), x: dv.getFloat32(o + 7, true), y: dv.getFloat32(o + 11, true), z: dv.getFloat32(o + 15, true) }
    }
    o += 7 + len
  }
  return null
}

/** steamid des Spielers, an dessen Füßen (≤ 48 u waagerecht, ≤ 80 u Höhe, 16-Hz-Frame) der Sound spielt */
function nearestPlayer(V1: MatchData['rounds'], s: Sos): string | undefined {
  const R = V1.find(R => s.tick >= R.frameTicks[0] && s.tick <= R.frameTicks[R.frameTicks.length - 1] + 4)
  if (!R) return
  const f = Math.min(R.frameTicks.length - 1, Math.max(0, Math.round((s.tick - R.frameTicks[0]) / 4)))
  let best: string | undefined, bd = 48 * 48
  for (const t of R.tracks) {
    const dx = t.x[f] - s.x, dy = t.y[f] - s.y, d = dx * dx + dy * dy
    if (d < bd && Math.abs(t.z[f] - s.z) <= 80 && t.hp[f] > 0) { bd = d; best = t.steamid }
  }
  return best
}

// ---------------------------------------------------------------- Liegende Waffen

const C4 = 49, DEFUSER = 55, TASER = 31
const PISTOL = new Set([1, 2, 3, 4, 30, 32, 36, 61, 63, 64])
const isNade = (d: number) => d >= 43 && d <= 48
/** Primärwaffen (Gewehre, MPs, Scharfschützen, MGs, Schrotflinten) */
const isPrimary = (d: number) => d > 0 && d < 70 && !PISTOL.has(d) && !isNade(d) && ![TASER, C4, 42, 57, 59].includes(d)
/** fallen lassen per G/Tausch: Waffen, Granaten, Zeus; C4 über bomb_dropped, Set über FLAG.defuser, Messer/Medi-Shot nie */
const droppable = (d: number) => isPrimary(d) || PISTOL.has(d) || isNade(d) || d === TASER
const NADE_CLASS: Record<number, string> = { 43: 'weapon_flashbang', 44: 'weapon_hegrenade', 45: 'weapon_smokegrenade', 46: 'weapon_molotov', 47: 'weapon_decoy', 48: 'weapon_incgrenade' }
/**
 * Granate beim Tod: user-demo zeigt je Leiche genau EINEN Granaten-Aufprall (trotz mp_death_drop_grenade 3 in gamemode_competitive.cfg):
 * die gehaltene, sonst Brand > HE > Blend > Rauch > Lockvogel (Reihenfolge aus den Aufprall-Mustern, 60 Leichen)
 */
const NADE_BEST = [46, 48, 44, 43, 45, 47]
/** Aufprall-Sound je Waffenart (game_sounds: weapon.<Art>.Impact); Lockvogel: kein Event gefunden → Flug geschätzt */
const IMPACT = new Map<number, (d: number) => boolean>(Object.entries({
  'weapon.Pistol.Impact': (d: number) => PISTOL.has(d) || d === TASER,
  'weapon.SMG.Impact': (d: number) => [17, 19, 23, 24, 26, 33, 34].includes(d),
  'weapon.Rifle.Impact': (d: number) => [7, 8, 10, 13, 16, 39, 60].includes(d),
  'weapon.Sniper.Impact': (d: number) => [9, 11, 38, 40].includes(d),
  'weapon.Heavy.Impact': (d: number) => d === 14 || d === 28,
  'weapon.Shotgun.Impact': (d: number) => [25, 27, 29, 35].includes(d),
  'weapon.C4.Impact': (d: number) => d === C4,
  'defuser.Impact': (d: number) => d === DEFUSER,
  'weapon.Flashbang.Impact': (d: number) => d === 43,
  'weapon.HEGrenade.Impact': (d: number) => d === 44,
  'weapon.Molotov.Impact': (d: number) => d === 46,
  // Rauch: kein eigenes Event, user-demo: freie Incendiary-Aufpralle 0–29 u neben Rauch-Abwürfen
  'weapon.Incendiary.Impact': (d: number) => d === 48 || d === 45,
}).map(([n, f]) => [soundHash(n), f]))
/** Abwurf mit G: Blickrichtung · THROW u/s + Laufgeschwindigkeit (geschätzt, CS:GO Weapon_Drop ähnlich) */
// shortcut: Wurf-/Fallgeschwindigkeit nicht aus CS2 gelesen; Liegeplatz kommt meist aus dem Aufprall-Sound, nur sonst zählt die Schätzung
const THROW = 250
/** Aufprall: höchstens so lange nach dem Abwurf (Ticks) und so weit vom Abwurfpunkt (u); Abpraller: Abstand je Sprung */
const IMPACT_T = 4 * 64, IMPACT_R = 450, BOUNCE_T = 52, BOUNCE_R = 160
/** Aufheben: Waffe höchstens so weit vom Spieler (u) */
const PICKUP_R = 300

/**
 * Liegende Waffen einer Demo. Abwurf = Inventar-Diff je 16-Hz-Frame (lebend, nicht geworfen/zurückgegeben), Tod = beste Waffe
 * (mp_death_drop_gun 1) + eine Granate (NADE_BEST) + Zeus + Set (mp_death_drop_defuser 1), C4 = bomb_dropped/bomb_pickup.
 * Liegeplatz aus dem Aufprall-Sound der Demo (user-demo 404/556, Rest geschätzt), Aufheben = item_pickup (ohne Kauf) bzw. Set-Flag.
 */
function dropsOf(V1: MatchData['rounds'], R3: Round3DIn[], invs: (number[] | undefined)[][][], rows: Row[], impacts: Sos[], pIdx: Map<string, number>, rate: number): Drop3D[] {
  const out: Drop3D[] = [], roundOf = (t: number) => V1.findIndex(R => t >= R.frameTicks[0] && t <= R.frameTicks[R.frameTicks.length - 1])
  const frameOf = (r: number, t: number) => Math.min(V1[r].frameTicks.length - 1, Math.max(0, Math.round((t - V1[r].frameTicks[0]) / 4)))
  const byP = new Map<string, Row[]>() // Events je steamid
  for (const e of rows) { const s = sid(e.user_steamid); if (s) (byP.get(s) ?? byP.set(s, []).get(s)!).push(e) }
  /** letzter Skin von def bei Spieler-Index p bis Frame f in Runde r (auch frühere Runden: Waffe überlebt) */
  const skinFor = (p: number, d: number, r: number, f: number) => {
    for (let q = r; q >= 0; q--) {
      const T = R3[q].tracks.find(t => t.player === p)
      if (T) for (let i = q === r ? f : T.weapon.length - 1; i >= 0; i--) if (T.weapon[i] === d) return T.skin[i]
    }
    return 0
  }
  const add = (r: number, k: number, d: number, tick: number, f: number, death: boolean) => {
    const t = V1[r].tracks[k], T = R3[r].tracks[k], f0 = Math.max(0, f - 1), dt = Math.max(1, V1[r].frameTicks[f] - V1[r].frameTicks[f0]) / rate
    const vx = (t.x[f] - t.x[f0]) / dt, vy = (t.y[f] - t.y[f0]) / dt, D = Math.PI / 180
    let x = t.x[f], y = t.y[f], z: number, wx: number, wy: number, wz: number
    if (death) {
      // aus der Hand am Körper, Streuung je Waffe fest (Tick + def), etwas Schwung vom Laufen
      // (user-demo, 256 Tod-Abwürfe mit Aufprall: waagerecht Median 45 u/s, 21 u bis zum Boden)
      const a = ((tick * 7919 + d * 104729) % 360) * D, s = 20 + ((tick + d) % 40)
      z = t.z[f] + 36 - 14 * T.duck[f]; wx = 0.3 * vx + Math.cos(a) * s; wy = 0.3 * vy + Math.sin(a) * s; wz = 60
    } else {
      const p = T.pitch[2 * f] * D, yw = T.yaw[2 * f] * D
      z = t.z[f] + 56 - 18 * T.duck[f]; wx = Math.cos(p) * Math.cos(yw) * THROW + vx; wy = Math.cos(p) * Math.sin(yw) * THROW + vy; wz = -Math.sin(p) * THROW
    }
    out.push({ tick, end: 0, def: d, skin: d === DEFUSER ? 0 : skinFor(T.player, d, r, f), x, y, z, vx: wx, vy: wy, vz: wz, land: 0, ix: 0, iy: 0, iz: 0, rx: 0, ry: 0, rz: 0 })
  }
  const deathTick = (s: string, a: number, b: number) => byP.get(s)?.find(e => e.event_name === 'player_death' && e.tick > a && e.tick <= b)?.tick ?? b
  const threw = (s: string, d: number, a: number, b: number) => byP.get(s)?.some(e => e.event_name === 'weapon_fire' && e.weapon === NADE_CLASS[d] && e.tick >= a && e.tick <= b) ?? false

  V1.forEach((R, r) => R.tracks.forEach((t, k) => {
    const T = R3[r].tracks[k], inv = invs[r][k], F = T.flags, n = R.frameTicks.length
    for (let f = 1; f < n; f++) inv[f] ??= inv[f - 1] // Lücken: Vorwert
    for (let f = 1; f < n; f++) {
      if (!(F[f - 1] & FLAG.alive)) continue
      const a = R.frameTicks[f - 1], b = R.frameTicks[f], prev = inv[f - 1] ?? [], cur = [...inv[f] ?? []]
      if (!(F[f] & FLAG.alive)) {
        // Tod: beste Waffe (Primär vor Pistole), EINE Granate (gehaltene, sonst die beste), Zeus, Set
        const dt = deathTick(t.steamid, a, b), gun = prev.find(isPrimary) ?? prev.find(d => PISTOL.has(d)), held = T.weapon[f - 1]
        const nade = isNade(held) && prev.includes(held) ? held : NADE_BEST.find(d => prev.includes(d))
        for (const d of [...gun ? [gun] : [], ...nade ? [nade] : [], ...prev.filter(d => d === TASER), ...F[f - 1] & FLAG.defuser ? [DEFUSER] : []]) add(r, k, d, dt, f - 1, true)
        continue
      }
      // lebend verloren: fallen gelassen, außer geworfen (weapon_fire der Granate) oder zurückgegeben (Geld steigt)
      const lost = prev.filter(d => { const i = cur.indexOf(d); if (i >= 0) { cur.splice(i, 1); return false } return droppable(d) })
      for (const d of lost) if (!(isNade(d) && threw(t.steamid, d, a - 16, b + 16)) && !(t.money[f] > t.money[f - 1])) add(r, k, d, b - 2, f, false)
    }
  }))
  // C4: bomb_dropped (lebend = geworfen, sonst Tod)
  for (const e of rows) if (e.event_name === 'bomb_dropped') {
    const r = roundOf(e.tick), s = sid(e.user_steamid), k = r < 0 || !s ? -1 : V1[r].tracks.findIndex(t => t.steamid === s)
    if (k < 0) continue
    const f = frameOf(r, e.tick), dead = !!byP.get(s!)?.some(x => x.event_name === 'player_death' && Math.abs(x.tick - e.tick) <= 2) || !(R3[r].tracks[k].flags[f] & FLAG.alive)
    add(r, k, C4, e.tick, dead ? Math.max(0, Math.min(f, frameOf(r, e.tick - 4))) : f, dead)
  }
  out.sort((a, b) => a.tick - b.tick)

  // Liegeplatz: erster Aufprall passender Art nach dem Abwurf (nah am Abwurfpunkt), dann Abpraller derselben Art bis zum letzten
  const used = new Uint8Array(impacts.length)
  for (const w of out) {
    let i = impacts.findIndex((s, j) => !used[j] && s.tick > w.tick && s.tick <= w.tick + IMPACT_T && IMPACT.get(s.hash)!(w.def) &&
      Math.hypot(s.x - w.x, s.y - w.y) <= IMPACT_R && s.z <= w.z + 50 && s.z >= w.z - 400)
    if (i < 0) continue
    used[i] = 1; w.land = impacts[i].tick; w.ix = w.rx = impacts[i].x; w.iy = w.ry = impacts[i].y; w.iz = w.rz = impacts[i].z
    for (let j = i + 1; j < impacts.length && impacts[j].tick <= impacts[i].tick + BOUNCE_T; j++) {
      const s = impacts[j]
      if (used[j] || s.hash !== impacts[i].hash || Math.hypot(s.x - impacts[i].x, s.y - impacts[i].y, s.z - impacts[i].z) > BOUNCE_R) continue
      used[j] = 1; i = j; w.rx = s.x; w.ry = s.y; w.rz = s.z
    }
  }

  // Aufheben: item_pickup ohne Kauf (Geld gleich) bzw. Set-Flag steigt → nächste liegende Waffe dieser Art in der Runde
  const pick = (r: number, d: number, tick: number, x: number, y: number) => {
    let best: Drop3D | undefined, bd = PICKUP_R
    for (const w of out) {
      if (w.def !== d || w.end || w.tick >= tick || roundOf(w.tick) !== r) continue
      const e = w.land ? Math.hypot(w.rx - x, w.ry - y) : Math.hypot(w.x + w.vx * 0.4 - x, w.y + w.vy * 0.4 - y)
      if (e < bd) { bd = e; best = w }
    }
    if (best) best.end = tick
  }
  for (const e of rows) {
    const s = sid(e.user_steamid)
    if (!s || !pIdx.has(s)) continue
    const C4ev = e.event_name === 'bomb_pickup', d = C4ev ? C4 : e.event_name === 'item_pickup' ? e.defindex : 0
    if (!d || (!C4ev && !droppable(d))) continue
    const r = roundOf(e.tick), k = r < 0 ? -1 : V1[r].tracks.findIndex(t => t.steamid === s)
    if (k < 0) continue
    const t = V1[r].tracks[k], f = frameOf(r, e.tick), money = t.money
    if (!C4ev && money[Math.min(money.length - 1, f + 1)] < money[Math.max(0, f - 1)]) continue // Kauf
    pick(r, d, e.tick, t.x[f], t.y[f])
  }
  V1.forEach((R, r) => R.tracks.forEach((t, k) => {
    const F = R3[r].tracks[k].flags
    for (let f = 1; f < F.length; f++) {
      if (F[f] & FLAG.defuser && !(F[f - 1] & FLAG.defuser) && F[f - 1] & FLAG.alive && F[f] & FLAG.alive && t.money[f] >= t.money[f - 1]) pick(r, DEFUSER, R.frameTicks[f], t.x[f], t.y[f])
    }
  }))
  return out
}
