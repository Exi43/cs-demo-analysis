// Kamera der Lineup-Bilder (rein, ohne three/DOM; Test views.test.ts): Augpunkt wie die 3D-Vorschau (preview/synth.ts), „Aim“ = Ego-Blick
// nach aim, „Position“ = schräg hinter und über dem Stand mit freier Sicht (Engine.raycast), dazu eine kurze Linie in Blickrichtung.
import type { FloorGrid } from '../../../shared/assets3d'
import type { Lineup } from '../../../shared/utility'
import { groundZ } from '../preview/synth'

type V3 = [number, number, number]
const D2R = Math.PI / 180
/** Positions-Kamera in dieser Vorliebe: weit weg (u), hinter dem Werfer (Versatz zu „genau hinten“, Grad), flach (Grad über der Waagerechten) */
export const DISTS = [260, 200, 150, 110], BEHIND = [0, 35, -35, 70, -70], FRONT = [110, -110, 180], ELEVS = [30, 45, 60]
/** Blickpunkt knapp unter Augenhöhe: der Ring am Boden liegt etwas unter der Bildmitte, darüber ist Platz für die Umgebung */
const LOOK_DZ = -16

/** Füße und Auge in Source-Units: z oder Boden-Raster wie synth.ts (fehlt beides: 0), Auge 64 u darüber, geduckt 46 */
export function feetEye(l: Pick<Lineup, 'stand' | 'technique'>, g: FloorGrid | null): { feet: V3; eye: V3 } {
  const z = l.stand.z ?? (g && groundZ(g, l.stand.x, l.stand.y)) ?? 0
  return { feet: [l.stand.x, l.stand.y, z], eye: [l.stand.x, l.stand.y, z + (l.technique.includes('crouch') ? 46 : 64)] }
}

/** Punkt d u von p in Richtung (pitch, yaw) wie CS (pitch + = nach unten) */
export function along(p: V3, pitch: number, yaw: number, d: number): V3 {
  const a = pitch * D2R, b = yaw * D2R
  return [p[0] + d * Math.cos(a) * Math.cos(b), p[1] + d * Math.cos(a) * Math.sin(b), p[2] - d * Math.sin(a)]
}

/**
 * Positions-Kamera gegen den Blick yaw, erste freie in der Vorliebe (free = Engine.raycast, Infinity = frei bis zur Kamera). Nichts frei
 * (Tunnel, enge Ecke): die Richtung mit dem längsten freien Weg, Kamera 16 u vor dem Treffer. behind = Kamera hinter dem Werfer
 * (davor käme die Blick-Linie direkt auf sie zu)
 */
export function posCamera(eye: V3, yaw: number, free: (a: V3, b: V3) => number): { pos: V3; look: V3; behind: boolean } {
  const look: V3 = [eye[0], eye[1], eye[2] + LOOK_DZ]
  let best = { pos: along(look, -30, yaw + 180, 40), h: 0, behind: true }
  for (const d of DISTS) for (const turns of [BEHIND, FRONT]) for (const e of ELEVS) for (const t of turns) {
    const pos = along(look, -e, yaw + 180 + t, d), h = free(look, pos), behind = turns === BEHIND
    if (h === Infinity) return { pos, look, behind }
    if (h > best.h) best = { pos: along(look, -e, yaw + 180 + t, Math.max(h / 2, h - 16)), h, behind }
  }
  return { pos: best.pos, look, behind: best.behind }
}
