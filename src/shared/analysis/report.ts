// Gemeinsame Eingabe der Team-Analyse (ein Team über eine oder mehrere Demos) und Stats-Zusammenführung.
// Die Analyse selbst steht in antistrat.ts (buildAntiStrat).
import type { MatchData } from '../model.ts'
import { finishStats, type PlayerStats } from '../stats.ts'

export interface Entry { match: MatchData; team: string }

/** Spieler-Stats mehrerer Demos addieren (Zähler summieren, Quoten neu berechnen) */
export function mergeStats(list: PlayerStats[][]): PlayerStats[] {
  const by = new Map<string, PlayerStats>()
  for (const ps of list) for (const p of ps) {
    const a = by.get(p.steamid)
    if (!a) { by.set(p.steamid, { ...p, multi: [...p.multi] as PlayerStats['multi'] }); continue }
    for (const k of Object.keys(p) as (keyof PlayerStats)[]) if (typeof p[k] === 'number') (a as any)[k] += p[k]
    p.multi.forEach((v, i) => (a.multi[i] += v))
  }
  for (const p of by.values()) finishStats(p)
  return [...by.values()]
}
