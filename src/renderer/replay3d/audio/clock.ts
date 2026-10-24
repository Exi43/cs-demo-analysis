// Gemeinsame Uhr für Voice und SFX (Critic P1-7): Demo-Sekunde ↔ AudioContext-Zeit, die genau dann aus dem Lautsprecher kommt.
// Anker über getOutputTimestamp (enthält die Gerätelatenz, ~1 ms Streuung), gemessen im voice-Spike: Versatz −0.27 … +0.04 ms.
import type { PlayState } from '../contracts'

/** fester Vorlauf (Lookahead) des Chromium-DynamicsCompressorNode, gemessen 6.0 ms */
export const COMP_DELAY = 0.006

export class Clock {
  /** null = gestoppt (Pause) */
  anchor: { demo: number; ctx: number; speed: number } | null = null
  /** hart neu geankert (Sprung, Tempo, Ruckler) */
  resyncs = 0
  /** still nachgestellt (kleine Uhren-Abweichung) */
  reanchors = 0
  /** Uhr aus getOutputTimestamp (~1 ms genau) statt currentTime (10-ms-Schritte) */
  private precise = false

  constructor(readonly ctx: AudioContext, readonly tickrate: number, private tolerance = 0.12) {}

  /** In jedem Bild. true = Wiedergabe beginnt neu (Start, Sprung, Tempo) → alle Quellen stoppen und neu planen */
  sync(s: PlayState): boolean {
    if (!s.playing) { this.anchor = null; return false }
    const demo = s.tick / this.tickrate, t = this.heard(s.at ?? performance.now()), a = this.anchor
    if (a) {
      const drift = Math.abs(a.demo + (t - a.ctx) * a.speed - demo)
      if (a.speed === s.speed && drift <= this.tolerance) {
        // kleine Abweichung (Ausgabe-Stream neu gestartet, Uhren laufen auseinander): nur neue Quellen nutzen den neuen Anker
        if (drift > (this.precise ? 0.004 : 0.015) * s.speed) { this.anchor = { demo, ctx: t, speed: s.speed }; this.reanchors++ }
        return false
      }
      this.resyncs++
    }
    this.anchor = { demo, ctx: t, speed: s.speed }
    return true
  }

  /** Kontext-Startzeit für Demo-Sekunde d (inkl. Kompressor-Vorlauf) */
  when(d: number): number { const a = this.anchor!; return a.ctx + (d - a.demo) / a.speed - COMP_DELAY }
  /** Demo-Sekunde, die zur Kontext-Zeit c zu hören ist */
  demoAt(c: number): number { const a = this.anchor!; return a.demo + (c + COMP_DELAY - a.ctx) * a.speed }

  /** Kontext-Zeit, die zur Wandzeit perfMs (performance.now-Basis) zu hören ist */
  heard(perfMs: number): number {
    const c = this.ctx, ts = c.getOutputTimestamp()
    this.precise = ts.contextTime! > 0 && ts.performanceTime! > 0
    if (this.precise) return ts.contextTime! + (perfMs - ts.performanceTime!) / 1000
    // Ausgabe-Stream läuft noch nicht: Schätzung über die gemeldete Latenz
    return c.currentTime - (c.baseLatency || 0) - (c.outputLatency || 0) + (perfMs - performance.now()) / 1000
  }
}
