// Bildtakt des 3D-Replays (ohne three/React): rAF mit Bildlimit aus options.ts, in der Pause ohne Last. Auch für das 2D-Replay.
// Gemessen (spike/animsound fx-cpu): Pause mit Neuzeichnen kostet ~2 Kerne, ohne 2–3 % Hauptthread; 60-fps-Limit halbiert das Abspielen.
// Gemessen 28.10. (240-Hz-Monitor): leerer rAF-Takt in der Pause ~5 % eines Kerns (Renderer + GPU-Prozess), minimiert spielend ~19 %.
//  - Abspielen: step je Bild bis fpsCap (ohne Fensterfokus fpsCapBackground), überzählige rAF werden übersprungen
//  - Pause: step nur nach jump(), invalidate() (Resize), Optionswechsel oder wantsFrame() (engine.dirty(): auch offene Effekt-/Skin-Arbeit);
//    ist nichts offen, schläft der Takt ganz (kein rAF), bis wake() (Engine.onDirty: Maus, Taste, Nachgeladenes) oder ein Aufruf oben kommt
//  - Fenster minimiert (setWindowShown, Main-Prozess; Chromium lässt die Seite dabei 'visible' und rAF weiterlaufen): kein step, kein rAF;
//    danach geht die Uhr ohne Sprung weiter, das Audio verstummt solange von selbst (kein update)
//  - onHud höchstens 15×/s und nur beim Abspielen oder nach Sprung/Play/Pause; onStats 2×/s per Timer (gemessene Bilder/s, Pause 0)
// View: step(now, dt) stellt die Uhr um dt vor (nur beim Abspielen > 0), dann engine.setTime + audio.update; am Ende setPlaying(false).
import { getOptions, onOptions } from './options'

export interface FrameLoopOpts {
  /** ein Bild: dt = ms Abspielzeit seit dem letzten step (0 in der Pause und im ersten Bild nach Play, höchstens 250) */
  step(now: number, dt: number): void
  /** engine.dirty(): in der Pause trotzdem zeichnen (Free-Cam, nachgeladenes Asset, offene Effekt-Arbeit); gefragt nur, solange der Takt wach ist */
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
  /** schlafenden Takt wecken, er fragt dann wantsFrame() (Engine.onDirty) */
  wake(): void
  stop(): void
}

const HUD_MS = 1000 / 15, BEAT_MS = 500, SLACK = 2 // ms Toleranz: rAF-Zeitstempel schwanken, sonst fällt jedes 2. Bild weg

let shown = true
const onShown = new Set<() => void>()
/** Fenster minimiert (false) bzw. wieder da (true), für alle Takte (App.tsx ← api.onWindowShown) */
export function setWindowShown(v: boolean) { shown = v; for (const f of onShown) f() }

export function createFrameLoop(o: FrameLoopOpts): FrameLoop {
  let playing = false, force = true, hud = true, raf = 0, stopped = false, timer: ReturnType<typeof setTimeout> | undefined
  let lastDraw = -Infinity, lastStep = -1, lastHud = -Infinity, frames = 0, lastStats = performance.now()
  const wake = () => { if (timer) { clearTimeout(timer); timer = undefined } if (!raf && !stopped && shown) raf = requestAnimationFrame(loop) }
  const offOpts = onOptions(() => { force = true; wake() })
  const show = () => { if (shown) { lastStep = -1; force = true; wake() } } // minimiert: Uhr stand, also ohne Sprung weiter
  onShown.add(show)
  const beat = setInterval(() => { const t = performance.now(); o.onStats(frames * 1000 / (t - lastStats)); frames = 0; lastStats = t }, BEAT_MS)
  const loop = (now: number) => {
    raf = 0
    if (!shown) return
    const opt = getOptions(), cap = (globalThis.document?.hasFocus() ?? true) ? opt.fpsCap : opt.fpsCapBackground
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
    if (!(playing || force || hud || o.wantsFrame())) return // schlafen bis wake()
    // bis zum nächsten fälligen Bild/HUD ohne rAF warten: sonst je Bild 4–16 leere rAF (15/60 fps auf 240 Hz), die Renderer + GPU-Prozess wecken
    const due = Math.min(force || !iv ? now : lastDraw + iv, playing || hud ? lastHud + HUD_MS : Infinity), wait = due - SLACK - performance.now()
    if (wait > 4) timer = setTimeout(() => { timer = undefined; wake() }, wait)
    else wake()
  }
  wake()
  return {
    setPlaying(on) { if (on !== playing) { playing = on; force = hud = true; lastStep = -1; wake() } },
    jump() { force = hud = true; wake() },
    invalidate() { force = true; wake() },
    wake,
    stop() { stopped = true; cancelAnimationFrame(raf); raf = 0; clearTimeout(timer); clearInterval(beat); offOpts(); onShown.delete(show) },
  }
}
