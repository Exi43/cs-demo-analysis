// Bildtakt des 3D-Replays (ohne three/React): rAF mit Bildlimit aus options.ts, in der Pause fast keine Last.
// Gemessen (spike/animsound fx-cpu): Pause mit Neuzeichnen kostet ~2 Kerne, ohne 2–3 % Hauptthread; 60-fps-Limit halbiert das Abspielen.
//  - Abspielen: step je Bild bis fpsCap (ohne Fensterfokus fpsCapUnfocused), überzählige rAF werden übersprungen
//  - Pause: step nur nach jump(), invalidate() (Resize), Optionswechsel oder wantsFrame() (engine.dirty(): auch offene Effekt-/Skin-Arbeit),
//    kein Herzschlag (er zeichnete 2×/s die ganze Szene neu, ~4 % Hauptthread)
//  - onHud höchstens 15×/s und nur beim Abspielen oder nach Sprung/Play/Pause; onStats ~2×/s auch in der Pause (gemessene Bilder/s, Pause ≈ 0)
// View: step(now, dt) stellt die Uhr um dt vor (nur beim Abspielen > 0), dann engine.setTime + audio.update; am Ende setPlaying(false).
import { getOptions, onOptions } from './options'

export interface FrameLoopOpts {
  /** ein Bild: dt = ms Abspielzeit seit dem letzten step (0 in der Pause und im ersten Bild nach Play, höchstens 250) */
  step(now: number, dt: number): void
  /** engine.dirty(): in der Pause trotzdem zeichnen (Free-Cam, nachgeladenes Asset, offene Effekt-Arbeit); nur gefragt, wenn das Limit ein Bild erlaubt */
  wantsFrame(): boolean
  /** React-HUD/Zeitleiste aktualisieren */
  onHud(): void
  /** gemessene Bilder/s (Anzahl step) */
  onStats(fps: number): void
}
export interface FrameLoop {
  setPlaying(on: boolean): void
  /** Sprung (Zeitleiste, Runde, ±15 s): nächstes Bild zeichnen und HUD aktualisieren */
  jump(): void
  /** nächstes Bild zeichnen (Resize, Kamerawechsel) */
  invalidate(): void
  stop(): void
}

const HUD_MS = 1000 / 15, BEAT_MS = 500, SLACK = 2 // ms Toleranz: rAF-Zeitstempel schwanken, sonst fällt jedes 2. Bild weg

export function createFrameLoop(o: FrameLoopOpts): FrameLoop {
  let playing = false, force = true, hud = true, raf = 0
  let lastDraw = -Infinity, lastStep = -1, lastHud = -Infinity, lastStats: number | undefined, frames = 0
  const offOpts = onOptions(() => { force = true })
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop)
    const opt = getOptions(), cap = (globalThis.document?.hasFocus() ?? true) ? opt.fpsCap : opt.fpsCapUnfocused
    const iv = cap ? 1000 / cap : 0, since = now - lastDraw
    if (since >= iv - SLACK && (playing || force || o.wantsFrame())) {
      // Takt halten (lastDraw + iv), nach Pause/Ruckler neu ansetzen
      lastDraw = since < 2 * iv ? lastDraw + iv : now
      const dt = playing && lastStep >= 0 ? Math.min(now - lastStep, 250) : 0
      lastStep = playing ? now : -1
      force = false; frames++
      o.step(now, dt)
    }
    if ((playing || hud) && now - lastHud >= HUD_MS - SLACK) { lastHud = now; hud = false; o.onHud() }
    lastStats ??= now
    if (now - lastStats >= BEAT_MS - SLACK) { o.onStats(frames * 1000 / (now - lastStats)); frames = 0; lastStats = now }
  }
  raf = requestAnimationFrame(loop)
  return {
    setPlaying(on) { if (on !== playing) { playing = on; force = hud = true; lastStep = -1 } },
    jump() { force = hud = true },
    invalidate() { force = true },
    stop() { cancelAnimationFrame(raf); offOpts() },
  }
}
