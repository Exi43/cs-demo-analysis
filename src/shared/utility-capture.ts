// Lineup-Vorschläge aus Demos („Aus Demo übernehmen“, api.utilityThrows): Granatenwurf aus CS3D → Lineup mit Standposition, Blick,
// Landepunkt und Wurftechnik. Rein (ohne Node/DOM): Main-Prozess (main/utility.ts) und Tests.
// Wurfphysik wie CS (an 828 Würfen der Profil-Demos geprüft): Start 675 u/s × (0,3 + 0,7 · Wurfstärke) + 1,25 × Spielertempo,
// Steigung = Pitch um bis zu 10° angehoben, Schwerkraft 320 u/s². Wurfstärke steht nicht in den Daten → aus der Startgeschwindigkeit.
import { BTN, FLAG, NADE, isDown, newSample, roundAt, sampleTrack, type CS3D } from './cs3d.ts'
import type { NadeType, ThrowCandidate } from './utility.ts'

/** CS3D-Granatentyp → Lineup-Typ (Brandgranate = molotov) */
export const NADE_TYPE: Record<number, NadeType> = { [NADE.smoke]: 'smoke', [NADE.flash]: 'flash', [NADE.he]: 'he', [NADE.molotov]: 'molotov', [NADE.incgrenade]: 'molotov', [NADE.decoy]: 'decoy' }
/** Wurf mit voller Stärke (u/s, weapons.vdata 750 · 0,9) und Faktor der Spielergeschwindigkeit */
export const THROW_SPEED = 675, THROW_INHERIT = 1.25
/** Startgeschwindigkeit ohne Spieleranteil → Maustaste (M1 675, M1+M2 439, M2 203 u/s) */
export const clickOf = (launch: number) => (launch >= 560 ? 'left' : launch >= 320 ? 'both' : 'right')
/** u/s: darunter steht der Spieler; ab RUN läuft er (Granate max. 245, Gehen 52 % = 127, geduckt 83) */
const MOVE = 40, RUN = 150
/** Stand und Ziel je näher als so viele u = ähnlicher Wurf */
export const SIMILAR_U = 64

const LABEL: Record<NadeType, string> = { smoke: 'Smoke', flash: 'Flash', molotov: 'Molotov', he: 'HE', decoy: 'Decoy' }

/**
 * Wurftechnik von Spur k in Runde r beim Wurf (tick): Bewegung stand | walk | run (Tempo am Wurf), crouch (geduckt), jump (in der Luft
 * oder Sprungtaste im Frame davor mit Absprung danach), dazu die Maustaste aus launch (Startgeschwindigkeit ohne Spieleranteil, fehlt → ohne)
 */
export function techniqueAt(d: CS3D, r: number, k: number, tick: number, launch?: number): string[] {
  const R = d.header.rounds[r], n = R.nFrames, fb = d.frameBase[r] + k * n, s = sampleTrack(d, r, k, tick, newSample())
  const fi = Math.max(0, Math.min(n - 1, Math.floor((tick - R.firstTick) / d.header.frameStep)))
  const at = (i: number) => fb + Math.max(0, Math.min(n - 1, i))
  const air = (i: number) => (d.flags[at(i)] & FLAG.airborne) !== 0, jumpKey = (i: number) => isDown(d.btnLo[at(i)], d.btnHi[at(i)], BTN.JUMP)
  const jump = air(fi) || air(fi + 1) || ((jumpKey(fi - 1) || jumpKey(fi) || jumpKey(fi + 1)) && air(fi + 2))
  const speed = Math.hypot(s.vx, s.vy), crouch = s.duck >= 0.5
  const out: string[] = []
  if (speed >= RUN) out.push('run')
  else if (speed >= MOVE) out.push('walk')
  else if (!jump && !crouch) out.push('stand')
  if (crouch) out.push('crouch')
  if (jump) out.push('jump')
  if (launch !== undefined) out.push(clickOf(launch))
  return out
}

/**
 * Wurf i aus CS3D → Lineup-Vorschlag (similar = 0, countSimilar zählt). side = Seite des Werfers in der Runde, place = Wurfort (v1 throwPlace).
 * Stand = Füße beim Wurf; in der Luft z vom letzten Boden-Frame (Absprung). Blick = pitch/yaw beim Wurf (yaw auf ±180 gefaltet).
 * Ziel = Wirkungsort (Smoke/Molotov/Decoy am Boden, Flash/HE auch in der Luft). null = Werfer ohne Spur (zwischen Runden, unbekannt).
 */
export function lineupFromThrow(d: CS3D, i: number, matchId: string, side: 'T' | 'CT', place = ''): ThrowCandidate | null {
  const N = d.nade, P = d.path, H = d.header, tick = N.throwTick[i], r = roundAt(d, tick), p = N.player[i], type = NADE_TYPE[N.type[i]]
  const k = r < 0 ? -1 : H.rounds[r].tracks.indexOf(p)
  if (k < 0 || !type || !H.players[p]) return null
  const R = H.rounds[r], n = R.nFrames, fb = d.frameBase[r] + k * n, s = sampleTrack(d, r, k, tick, newSample())
  // Startgeschwindigkeit aus den ersten Pfadpunkten (32 Hz, ≤ 0,1 s: vor dem ersten Abprall), Spieleranteil abgezogen
  const a = N.pathStart[i], b = Math.min(N.pathStart[i + 1] - 1, a + 3), dt = (P.tick[b] - P.tick[a]) / H.tickrate
  const launch = dt > 0 ? Math.hypot((P.x[b] - P.x[a]) / dt - THROW_INHERIT * s.vx, (P.y[b] - P.y[a]) / dt - THROW_INHERIT * s.vy, (P.z[b] - P.z[a]) / dt - THROW_INHERIT * s.vz) : undefined
  const technique = techniqueAt(d, r, k, tick, launch)
  const fi = Math.max(0, Math.min(n - 1, Math.floor((tick - R.firstTick) / H.frameStep)))
  let z = s.z
  // Absprung: letzter Boden-Frame höchstens 1 s davor
  if (technique.includes('jump')) for (let j = fi; j >= Math.max(0, fi - 16); j--) if (!(d.flags[fb + j] & FLAG.airborne)) { z = d.z[fb + j]; break }
  const r1 = (v: number) => Math.round(v * 10) / 10, r2 = (v: number) => Math.round(v * 100) / 100
  const name = H.players[p].name, steamid = H.players[p].steamid, round = R.num
  return {
    matchId, tick, steamid, player: name, round, map: H.map, type, side, similar: 0,
    lineup: {
      map: H.map, type, side, title: `${LABEL[type]}${place ? ` from ${place}` : ''}`,
      stand: { x: r1(s.x), y: r1(s.y), z: r1(z) }, target: { x: r1(N.x[i]), y: r1(N.y[i]), z: r1(N.z[i]) },
      aim: { pitch: r2(s.pitch), yaw: r2(((s.yaw % 360) + 540) % 360 - 180) },
      technique, steps: [], images: [], tags: [],
      demo: { matchId, tick, steamid, player: name, round },
    },
  }
}

/** similar je Wurf = Anzahl anderer Würfe gleicher Map und gleichen Typs mit Stand und Ziel je < SIMILAR_U (3D-Abstand); schreibt in list */
export function countSimilar(list: ThrowCandidate[]): ThrowCandidate[] {
  const near = (u: { x: number; y: number; z?: number }, v: { x: number; y: number; z?: number }) => Math.hypot(u.x - v.x, u.y - v.y, (u.z ?? 0) - (v.z ?? 0)) < SIMILAR_U
  const groups = new Map<string, ThrowCandidate[]>()
  for (const c of list) {
    c.similar = 0
    const key = `${c.map}|${c.type}`, g = groups.get(key)
    if (g) g.push(c); else groups.set(key, [c])
  }
  // shortcut: paarweise je Map/Typ (einige hundert Würfe je Map); bei vielen Demos Raster nach Stand-Zelle
  for (const g of groups.values()) for (let x = 0; x < g.length; x++) for (let y = x + 1; y < g.length; y++) {
    if (near(g[x].lineup.stand, g[y].lineup.stand) && near(g[x].lineup.target, g[y].lineup.target)) { g[x].similar++; g[y].similar++ }
  }
  return list
}
