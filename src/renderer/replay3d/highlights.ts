// Highlights wie im CS Demo Manager (Berat 28.10.): Kills ("Highlights") und Tode ("Lowlights") eines Spielers oder aller als Liste.
// Sprung 5 s vor das Ereignis in die Ego-Sicht des Killers (Kill) bzw. des Opfers (Tod); "Play all" zeigt je Eintrag −5 s … +2 s und
// springt dann weiter. Reine Funktionen aus v1 (MatchData), ohne DOM/three; die Liste rechnet die UI nur bei offenem Panel.
import type { MatchData, Side } from '../../shared/model'

/** Sekunden vor bzw. nach dem Kill */
export const BEFORE_S = 5, AFTER_S = 2
const ROUND_S = 115 // Rundenzeit ab Freeze-Ende (wie hud/state.ts)

export type HighlightKind = 'kill' | 'death'
export type HighlightFilter = HighlightKind | 'both'

export interface Highlight {
  kind: HighlightKind
  /** Tick des Kills */
  tick: number
  /** v1 Round.num */
  round: number
  /** Sprungziel: BEFORE_S vor dem Kill, nicht vor Rundenstart */
  start: number
  /** Ende in "Play all": AFTER_S nach dem Kill */
  end: number
  /** Ego-Sicht: Killer bei Kills, Opfer bei Toden */
  pov: string
  /** fehlt bei Welt/Selbstmord */
  attacker?: string
  attackerSide?: Side
  victim: string
  victimSide: Side
  weapon: string
  headshot: boolean
  /** Rundenuhr beim Kill in s (115 s ab Freeze-Ende, ohne Bombenzeit) */
  clock: number
}

/**
 * Kills und/oder Tode von player (null = alle Spieler), nach Tick sortiert. Kill = Angreifer ≠ Opfer (Selbstmord/Welt nur als Tod,
 * wie timeline() in hud/state.ts). Bei allen Spielern steht jedes Ereignis nur einmal da: als Kill, sonst als Tod.
 */
export function highlights(match: MatchData, player: string | null, filter: HighlightFilter): Highlight[] {
  const rate = match.tickrate || 64, out: Highlight[] = []
  for (const R of match.rounds) {
    const side = (sid?: string) => (sid ? R.tracks.find(t => t.steamid === sid)?.side : undefined)
    for (const k of R.kills) {
      const kill = filter !== 'death' && !!k.attacker && k.attacker !== k.victim && (!player || k.attacker === player)
      if (!kill && (filter === 'kill' || (player && k.victim !== player))) continue
      out.push({
        kind: kill ? 'kill' : 'death', tick: k.tick, round: R.num, start: Math.max(R.startTick, k.tick - BEFORE_S * rate), end: k.tick + AFTER_S * rate,
        pov: kill ? k.attacker! : k.victim, attacker: k.attacker, attackerSide: side(k.attacker), victim: k.victim, victimSide: side(k.victim) ?? 'CT',
        weapon: k.weapon, headshot: k.headshot, clock: Math.max(0, ROUND_S - (k.tick - R.freezeEndTick) / rate),
      })
    }
  }
  return out.sort((a, b) => a.tick - b.tick)
}

/**
 * "Play all" im HUD-Takt: 'play' = list[i] läuft noch, 'next' = list[i] ist durch, 'done' = der letzte ist durch, 'cancel' = der
 * Nutzer ist aus dem Fenster gesprungen (Zeitleiste, ±15 s, Runde). 3 s Spielraum: der HUD-Takt (15/s) läuft bei 4x 0,27 s weit.
 */
export function reelStep(list: readonly Highlight[], i: number, tick: number, rate: number): 'play' | 'next' | 'done' | 'cancel' {
  const h = list[i]
  if (tick < h.start - rate || tick > h.end + 3 * rate) return 'cancel'
  return tick < h.end ? 'play' : i + 1 < list.length ? 'next' : 'done'
}
