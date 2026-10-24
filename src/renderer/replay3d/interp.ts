// Abtastung der CS3D-Spuren für Engine, Effekte und Audio.
// Catmull-Rom (Position 16 Hz, pitch/yaw 32 Hz) mit Teleport-Schutz steckt in shared/cs3d.ts sampleCR/sampleTrack;
// hier: Spieler-Index → Runde/Track, letzten Frame zwischen den Runden halten, Winkel-Wrap.
import { sampleTrack, type CS3D, type TrackSample } from '../../shared/cs3d.ts'

/** Grad → [−180, 180). Spur-yaw ist stetig (kann 900° sein), Schuss-yaw (shot.yaw) liegt schon in ±180. */
export const wrapDeg = (a: number) => a - 360 * Math.floor((a + 180) / 360)
/** Winkel auf kürzestem Weg mischen (Kamera-Übergänge, Schuss-yaw ↔ Spur-yaw) */
export const lerpDeg = (a: number, b: number, t: number) => a + wrapDeg(b - a) * t

/** Runde für tick: laufende Runde, zwischen zwei Runden die vorige (sampleTrack hält deren letzten Frame), davor die erste; −1 ohne Runden */
export function roundHold(d: CS3D, tick: number): number {
  const R = d.header.rounds
  let r = R.length - 1
  while (r > 0 && tick < R[r].firstTick) r--
  return r
}

/** Zustand von Spieler-Index p (header.players) bei gebrochenem tick → out. false = Spieler hat in dieser Runde keine Spur. */
export function samplePlayer(d: CS3D, p: number, tick: number, out: TrackSample): boolean {
  const r = roundHold(d, tick)
  const k = r < 0 ? -1 : d.header.rounds[r].tracks.indexOf(p)
  if (k < 0) return false
  sampleTrack(d, r, k, tick, out)
  return true
}
