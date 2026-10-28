// Utility-Vorschau ohne Demo (Variante b): aus einem Lineup ein kurzes künstliches CS3D-„Demo“, das die 3D-Engine wie eine echte Demo
// abspielt: ein Spieler (Standard-Agent seiner Seite, Ego-Sicht) auf der Standposition mit dem Blick des Lineups, die Wurftechnik als
// Tasten-Kanal (gleiche Tasten-Anzeige wie bei Demos), Granate ziehen → Pin → Wurf (weapon_fire beim Loslassen: Ego-Hände und
// Agent werfen wie in Demos, actions.ts) und eine Granate auf einer angenäherten Flugbahn bis zum Ziel. Rein (ohne three/DOM), Test: synth.test.ts.
// Wurfphysik wie CS (shared/utility-capture.ts), Sprung: 302 u/s Absprung, 800 u/s² (CS2-Spieler).
import { AGENT_DEFAULT, BTN, EV, NADE, decode3d, encode3d, FLAG, type ButtonName, type CS3D, type Nade3D, type Track3DIn } from '../../../shared/cs3d'
import type { FloorGrid } from '../../../shared/assets3d'
import type { MatchData } from '../../../shared/model'
import type { Lineup, Vec3 } from '../../../shared/utility'
import { THROW_INHERIT, THROW_SPEED } from '../../../shared/utility-capture'
import { OUT_S } from './camera'

const RATE = 64, STEP = 4, FPS = RATE / STEP
const D2R = Math.PI / 180
/** Granaten-Schwerkraft (u/s²), Spieler-Sprung (u/s, u/s²), Tempo mit Granate (u/s): laufen, gehen, geduckt */
export const NADE_G = 320
const JUMP_V = 302, PLAYER_G = 800, RUN_V = 245, WALK_V = 127, DUCK_V = 83
/**
 * Zeitplan (s, auf 16-Hz-Frames): Granate ab dem 2. Frame in der Hand (Zieh-Clip 1 s), Pin ziehen (Clip ≤ 1,1 s), Ducken, Loslassen ohne /
 * mit Anlauf, Anlauf, Hand nach dem Wurf-Clip leer (keine nächste Granate), nach der Wirkung bis zum Ende. Die Granate fliegt SPAWN nach
 * dem Loslassen los (CS2-Wurfanimation; Ancient-Jumpthrow: Start-vz 710 u/s = Spieler 0,12 s nach dem Absprung)
 */
const PIN = 1, DUCK = 0.25, REL = 2.125, REL_MOVE = 2.625, RUNUP = 0.625, SPAWN = 0.125, EMPTY = 0.75, TAIL = OUT_S
const DEF: Record<Lineup['type'], number> = { smoke: 45, flash: 43, he: 44, molotov: 46, decoy: 47 }
const TYPE: Record<Lineup['type'], number> = { smoke: NADE.smoke, flash: NADE.flash, he: NADE.he, molotov: NADE.molotov, decoy: NADE.decoy }
/** Klassenname fürs weapon_fire-Ereignis je Def (Brandgranate 48) */
const CLS: Record<number, string> = { 43: 'weapon_flashbang', 44: 'weapon_hegrenade', 45: 'weapon_smokegrenade', 46: 'weapon_molotov', 47: 'weapon_decoy', 48: 'weapon_incgrenade' }
/** Wirkdauer (s) nach der Detonation: Smoke, Feuer, Decoy */
const LASTS: Partial<Record<Lineup['type'], number>> = { smoke: 18, molotov: 7, decoy: 15 }
export const SYNTH_ID = 'lineup-preview'

/**
 * Boden unter (x, y) ohne bekannte Höhe: niedrigste Lage mit Kopffreiheit (keine Lage 12–60 u darüber; tiefer liegt oft Map-Unterseite,
 * höher Dächer), dann oben auf ihrer Stufe (Lagen ≤ 24 u darüber). An den Wurfpositionen der Profil-Demos 88 % (Dust2) bzw. 98 % (Ancient)
 * auf 20 u genau. Leere Zelle: Nachbarn bis 2 Zellen; nichts → undefined.
 */
export function groundZ(g: FloorGrid, x: number, y: number): number | undefined {
  const cx0 = Math.floor((x - g.minX) / g.cell), cy0 = Math.floor((y - g.minY) / g.cell)
  for (let rad = 0; rad <= 2; rad++) for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
    const cx = cx0 + dx, cy = cy0 + dy
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad || cx < 0 || cy < 0 || cx >= g.W || cy >= g.H) continue
    const c = cy * g.W + cx, L = Array.from(g.z.subarray(g.offs[c], g.offs[c + 1])).sort((a, b) => a - b)
    if (!L.length) continue
    let z = L.find(a => !L.some(b => b > a + 12 && b <= a + 60)) ?? L[L.length - 1]
    for (const b of L) if (b > z && b <= z + 24) z = b
    return z
  }
}

/** Richtung (Source) aus CS-Winkeln: pitch + = nach unten */
const dir = (pitch: number, yaw: number): Vec3 => ({ x: Math.cos(pitch * D2R) * Math.cos(yaw * D2R), y: Math.cos(pitch * D2R) * Math.sin(yaw * D2R), z: -Math.sin(pitch * D2R) })
/** Blick von a nach b in CS-Winkeln */
export const lookAt = (a: Vec3, b: Vec3) => ({ pitch: -Math.atan2(b.z - a.z, Math.hypot(b.x - a.x, b.y - a.y)) / D2R, yaw: Math.atan2(b.y - a.y, b.x - a.x) / D2R })

/**
 * Angenäherte Flugbahn [tick, x, y, z] (32 Hz) von from bis zum Ziel: Steigung aus dem Blick (wie CS um bis zu 10° angehoben) bzw. ohne
 * Blick der flache Wurf, der das Ziel mit voller Stärke erreicht (sonst 45°); Startgeschwindigkeit THROW_SPEED · (0,3 + 0,7 · Stärke) +
 * 1,25 · Tempo des Spielers (vz senkrecht, vh waagerecht in Wurfrichtung), Schwerkraft NADE_G. Waagerecht gleichmäßig bis zum Ziel gestreckt
 * (ohne Wände); liegt das Ziel deutlich vor der ballistischen Landung, prallte der echte Wurf ab (Wand, Decke): ballistisch bis zur
 * Zielentfernung, dann fällt sie dort aufs Ziel. Gestaucht lag der Bogen in der Mitte weit über dem echten Wurf (durch Decken und Vorsprünge;
 * gut ein Viertel der Startpaket-Lineups, vor allem Molotovs)
 */
export function approxPath(from: Vec3, target: Vec3, t0: number, aim: { pitch: number } | undefined, strength: number, vz = 0, vh = 0): [number, number, number, number][] {
  const D = Math.hypot(target.x - from.x, target.y - from.y), h = target.z - from.z, v = THROW_SPEED * (0.3 + 0.7 * strength)
  let elev: number
  if (aim) elev = -(aim.pitch - ((90 - Math.abs(aim.pitch)) * 10) / 90) * D2R
  else { const q = v ** 4 - NADE_G * (NADE_G * D * D + 2 * h * v * v); elev = q >= 0 && D > 1 ? Math.atan((v * v - Math.sqrt(q)) / (NADE_G * D)) : Math.PI / 4 }
  const vz0 = v * Math.sin(elev) + THROW_INHERIT * vz, hs = Math.max(50, v * Math.cos(elev))
  // Flugzeit: absteigender Ast bei Zielhöhe; zu hoch/zu flach → Zeit aus dem waagerechten Tempo, Höhe linear auf das Ziel gezogen
  const disc = vz0 * vz0 - 2 * NADE_G * h, out: [number, number, number, number][] = []
  const zAt = (t: number) => from.z + vz0 * t - (NADE_G * t * t) / 2, hv = hs + THROW_INHERIT * vh, t1 = D / hv
  if (aim && disc >= 0 && (hv * (vz0 + Math.sqrt(disc))) / NADE_G * 0.8 > D && zAt(t1) > target.z) {
    const z1 = zAt(t1), vz1 = Math.min(0, vz0 - NADE_G * t1) // Abprall nimmt das Steigen mit
    const n = Math.max(8, Math.ceil(32 * Math.min(6, t1 + (vz1 + Math.sqrt(vz1 * vz1 + 2 * NADE_G * (z1 - target.z))) / NADE_G)))
    for (let i = 0; i <= n; i++) {
      const t = i / 32, f = Math.min(1, t / t1), s = t - t1
      out.push([Math.round(t0 + t * RATE), from.x + (target.x - from.x) * f, from.y + (target.y - from.y) * f, i === n ? target.z : s <= 0 ? zAt(t) : Math.max(target.z, z1 + vz1 * s - (NADE_G * s * s) / 2)])
    }
    return out
  }
  const n = Math.max(8, Math.ceil(32 * Math.min(6, disc >= 0 ? (vz0 + Math.sqrt(disc)) / NADE_G : D / hs))), T = n / 32 // auf 32-Hz-Punkte (2 Ticks)
  const zEnd = from.z + vz0 * T - (NADE_G * T * T) / 2
  for (let i = 0; i <= n; i++) {
    const f = i / n, t = f * T
    out.push([Math.round(t0 + t * RATE), from.x + (target.x - from.x) * f, from.y + (target.y - from.y) * f, from.z + vz0 * t - (NADE_G * t * t) / 2 + (target.z - zEnd) * f])
  }
  return out
}

export interface Synth {
  data: { match: MatchData; d: CS3D }
  steamid: string
  /** Ticks: Anfang, Wurf (Granate fliegt los), Wirkung am Ziel, Ende (1 s danach) */
  from: number; throwTick: number; det: number; to: number
  marks: { path: [number, number, number][]; target: [number, number, number] }
}

/** Lineup → Mini-Demo; g = Boden-Raster der Map für fehlende Höhen (fehlt beides: z = 0) */
export function synthLineup(l: Lineup, g: FloorGrid | null): Synth {
  const has = (t: string) => l.technique.includes(t)
  const wjump = has('wjumpthrow') // W + Jumpthrow = mit W anlaufen und springen
  const jump = has('jump') || has('jumpthrow') || wjump, crouch = has('crouch'), run = has('run') || wjump, walk = !run && has('walk')
  const click: ButtonName[] = has('right') ? ['ATTACK2'] : has('both') ? ['ATTACK', 'ATTACK2'] : ['ATTACK']
  const strength = has('right') ? 0 : has('both') ? 0.5 : 1
  const speed = run ? RUN_V : walk ? (crouch ? DUCK_V : WALK_V) : 0
  const z0 = l.stand.z ?? (g && groundZ(g, l.stand.x, l.stand.y)) ?? 0
  const target = { x: l.target.x, y: l.target.y, z: l.target.z ?? (g && groundZ(g, l.target.x, l.target.y)) ?? z0 }
  const eye0 = { x: l.stand.x, y: l.stand.y, z: z0 + 64 - (crouch ? 18 : 0) }
  const aim = l.aim ?? lookAt(eye0, target)
  const fwd = dir(0, aim.yaw) // Anlauf waagerecht in Blickrichtung
  // Zeitplan (s ab Anfang): Pin, Anlauf, Loslassen (Jumpthrow: Space im selben Frame), Granate SPAWN später am Stand (Füße auf l.stand)
  const rel = speed ? REL_MOVE : REL, spawn = rel + SPAWN, move0 = rel - RUNUP, moveEnd = spawn + 0.25
  const hop = (t: number) => { const s = t - rel; return jump && s > 0 ? Math.max(0, JUMP_V * s - (PLAYER_G * s * s) / 2) : 0 }
  const off = (t: number) => speed * (Math.min(Math.max(t, move0), moveEnd) - spawn) // Weg entlang fwd relativ zum Stand
  const duckAt = (t: number) => (crouch ? Math.min(1, Math.max(0, (t - DUCK) / 0.2)) : 0)
  // Wurf: Auge beim Start der Granate + 16 u in Wurfrichtung; Jumpthrow: Spieler steigt noch (vz geht in den Wurf ein)
  const eye = { x: l.stand.x, y: l.stand.y, z: z0 + hop(spawn) + 64 - 18 * duckAt(spawn) }, d0 = dir(aim.pitch, aim.yaw)
  const start = { x: eye.x + 16 * d0.x, y: eye.y + 16 * d0.y, z: eye.z + 16 * d0.z }
  const first = 1000, throwTick = first + Math.round(spawn * RATE)
  const path = approxPath(start, target, throwTick, l.aim, strength, jump ? JUMP_V - PLAYER_G * SPAWN : 0, speed)
  // Wirkung bei der Landung (ohne Rollen), Smoke/Feuer/Decoy bleiben LASTS stehen; die Vorschau endet TAIL danach (Außenansicht)
  const det = path[path.length - 1][0], end = det + Math.round((LASTS[l.type] ?? 0) * RATE)
  const nFrames = Math.ceil((det + TAIL * RATE - first) / STEP) + 1
  const T: Track3DIn = { player: 0, x: [], y: [], z: [], duck: [], btnLo: [], btnHi: [], flags: [], weapon: [], fov: [], ammo: [], skin: [], pitch: [], yaw: [], aimP: [], aimY: [], viewP: [], viewY: [] }
  const bits = (names: ButtonName[]) => names.reduce((b, n) => (b | (1 << BTN[n])) >>> 0, 0)
  const inc = l.type === 'molotov' && l.side === 'CT', def = inc ? 48 : DEF[l.type]
  for (let i = 0; i < nFrames; i++) {
    const t = i / FPS, keys: ButtonName[] = [], o = off(t), up = hop(t)
    if (t >= PIN && t < rel) keys.push(...click)
    if (speed && t >= move0 && t < moveEnd) keys.push('FORWARD', ...(walk && !crouch ? ['WALK' as const] : []))
    if (crouch && t >= DUCK) keys.push('DUCK')
    if (jump && t >= rel && t < rel + 2 / FPS) keys.push('JUMP')
    T.x.push(l.stand.x + fwd.x * o); T.y.push(l.stand.y + fwd.y * o); T.z.push(z0 + up); T.duck.push(duckAt(t))
    T.btnLo.push(bits(keys)); T.btnHi.push(0)
    T.flags.push(FLAG.alive | (up > 0 ? FLAG.airborne : 0) | (keys.includes('WALK') ? FLAG.walking : 0))
    T.weapon.push(i > 0 && t < rel + EMPTY ? def : 0); T.fov.push(0); T.ammo.push(1); T.skin.push(0)
  }
  for (let j = 0; j < 2 * nFrames - 1; j++) { T.pitch.push(aim.pitch); T.yaw.push(aim.yaw); T.aimP.push(0); T.aimY.push(0); T.viewP.push(0); T.viewY.push(0) }
  const nade: Nade3D = {
    type: inc ? NADE.incgrenade : TYPE[l.type], player: 0, throwTick, detTick: det, endTick: Math.max(det, end),
    x: target.x, y: target.y, z: target.z, path,
  }
  // Agent beider Seiten = Standard-Agent der Lineup-Seite (die Engine nimmt ohne v1-Runde Seite T an): Modell und Ego-Arme passen
  const agent = AGENT_DEFAULT[l.side === 'CT' ? 'CT' : 'T']
  const d = decode3d(encode3d({
    matchId: SYNTH_ID, map: l.map, tickrate: RATE, skins: [], shots: [], voice: [], nades: [nade],
    events: [{ tick: first + Math.round(rel * RATE), type: EV.weapon_fire, player: 0, arg: CLS[def] }], // Wurf beim Loslassen
    players: [{ steamid: SYNTH_ID, name: l.title, team: '', agent: { T: agent, CT: agent } }],
    rounds: [{ num: 1, firstTick: first, nFrames, tracks: [T] }],
  }))
  const match: MatchData = { version: 1, id: SYNTH_ID, fileName: '', map: l.map, parsedAt: '', tickrate: RATE, serverName: '', players: [], teams: [], finalScore: {}, rounds: [] }
  return {
    data: { match, d }, steamid: SYNTH_ID, from: first, throwTick, det, to: first + (nFrames - 1) * STEP,
    marks: { path: path.map(p => [p[1], p[2], p[3]]), target: [target.x, target.y, target.z] },
  }
}
